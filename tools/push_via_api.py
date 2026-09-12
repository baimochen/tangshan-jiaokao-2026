#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 github.com:443 连不上、但 api.github.com 可达的网络下，用 GitHub 的
Git 数据 API 把本地提交推上去。

背景：某些网络环境下（实测本机就是），
    api.github.com      通
    ssh.github.com:443  通（但没有 SSH 密钥）
    github.com:22       通（同上）
    github.com:443      连不上  ← git push 走的就是这个，所以直接推必失败

原理：逐个文件建 blob → 组 tree → 建 commit → 改 ref。
关键在于**逐字段对齐本地提交**（tree / parents / author / committer / message），
让远端 commit 的 SHA 与本地完全相同——本地和远端不会分叉，
以后网络正常了直接 `git push` 就是快进。

用法：
    python3 tools/push_via_api.py            # 推到 main
    python3 tools/push_via_api.py --dry-run  # 只校验，不改远端

前提：gh 已登录（`gh auth status`），且 token 有 repo 权限。不需要 admin:public_key。
"""
import base64
import json
import os
import subprocess
import sys

DRY = '--dry-run' in sys.argv


def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, check=True, **kw)


def git(*args):
    return sh('git', *args).stdout.decode('utf-8')


def api(endpoint, payload=None, method=None):
    cmd = ['gh', 'api', endpoint]
    if method:
        cmd += ['--method', method]
    if payload is not None:
        cmd += ['--input', '-']
    r = subprocess.run(
        cmd,
        input=json.dumps(payload) if payload is not None else None,
        capture_output=True, text=True)
    return r


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)

    url = git('remote', 'get-url', 'origin').strip()
    # https://github.com/OWNER/REPO.git  或  git@github.com:OWNER/REPO.git
    slug = url.split('github.com')[-1].lstrip(':/').removesuffix('.git')
    repo = slug
    print(f'目标仓库 {repo}')

    # ---- 本地提交：从 raw 对象取，保证一个字节都不差 ----
    raw = sh('git', 'cat-file', 'commit', 'HEAD').stdout
    head, _, msg = raw.partition(b'\n\n')
    lines = head.decode('utf-8').split('\n')
    tree = lines[0].split()[1]
    parents = [l.split()[1] for l in lines if l.startswith('parent ')]

    def ident(prefix):
        line = next(l for l in lines if l.startswith(prefix + ' '))
        rest = line[len(prefix) + 1:]
        name, _, tail = rest.partition(' <')
        email, _, when = tail.partition('> ')
        return name, email, when

    an, ae, _ = ident('author')
    cn, ce, _ = ident('committer')
    local_sha = git('rev-parse', 'HEAD').strip()
    print(f'本地提交 {local_sha[:8]}  tree {tree[:8]}  parent {len(parents)} 个')

    # ---- 空仓库要先激活：Git 数据 API 拒绝在没有任何提交的仓库上建 blob ----
    ref = api(f'/repos/{repo}/git/refs/heads/main')
    if ref.returncode != 0 and 'empty' in ref.stderr.lower():
        if DRY:
            print('仓库为空（dry-run 不做激活）')
            return
        print('仓库为空，先放一个占位提交激活…')
        r = api(f'/repos/{repo}/contents/.bootstrap', {
            'message': 'init',
            'content': base64.b64encode(b'init\n').decode(),
        }, method='PUT')
        if r.returncode != 0:
            print('激活失败:', r.stderr[:300])
            sys.exit(1)
        # 激活后 main 指向占位提交，但我们下面会用 parents=[] 建一个根提交再强指过去，
        # 占位提交变成不可达对象，不进历史。

    # ---- 逐个文件建 blob ----
    entries = []
    for rec in sh('git', 'ls-tree', '-r', '-z', 'HEAD').stdout.decode('utf-8').split('\0'):
        if not rec:
            continue
        meta, path = rec.split('\t', 1)
        mode, _, sha = meta.split()
        entries.append((mode, sha, path))

    print(f'共 {len(entries)} 个文件，上传 blob…')
    if DRY:
        print('（dry-run：不实际上传）')
        return
    tree_entries, bad = [], []
    for i, (mode, sha, path) in enumerate(entries, 1):
        b64 = base64.b64encode(open(path, 'rb').read()).decode()
        r = api(f'/repos/{repo}/git/blobs', {'content': b64, 'encoding': 'base64'})
        if r.returncode != 0:
            print(f'  上传失败 {path}:', r.stderr[:200])
            sys.exit(1)
        got = json.loads(r.stdout)['sha']
        if got != sha:
            bad.append((path, sha, got))
        tree_entries.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': got})
        if i % 20 == 0 or i == len(entries):
            print(f'  {i}/{len(entries)}')

    if bad:
        print('!! blob SHA 与本地不一致，内容被改动了，已中止：')
        for p, a, b in bad[:5]:
            print(f'   {p}: 本地 {a[:8]} vs 远端 {b[:8]}')
        sys.exit(1)
    print('✅ 全部 blob SHA 与本地一致（内容一个字节没变）')

    # ---- tree ----
    r = api(f'/repos/{repo}/git/trees', {'tree': tree_entries})
    remote_tree = json.loads(r.stdout)['sha']
    print(f'远端 tree {remote_tree[:8]}  ' +
          ('✅ 与本地一致' if remote_tree == tree else f'!! 本地是 {tree[:8]}'))
    if remote_tree != tree:
        sys.exit(1)

    # ---- commit：逐字段对齐，SHA 必须与本地相同 ----
    def iso(when):
        # git 的 raw 形式是 "<unix_ts> <tz>"，API 要 ISO 8601
        ts, tz = when.split()
        import datetime
        off = datetime.timezone(datetime.timedelta(
            hours=int(tz[1:3]), minutes=int(tz[3:5]) * (1 if tz[0] == '+' else -1)))
        return datetime.datetime.fromtimestamp(int(ts), off).isoformat()

    _, _, ad = ident('author')
    _, _, cd = ident('committer')
    r = api(f'/repos/{repo}/git/commits', {
        'message': msg.decode('utf-8'),
        'tree': remote_tree,
        'parents': parents,
        'author': {'name': an, 'email': ae, 'date': iso(ad)},
        'committer': {'name': cn, 'email': ce, 'date': iso(cd)},
    })
    if r.returncode != 0:
        print('建 commit 失败:', r.stderr[:400])
        sys.exit(1)
    remote_sha = json.loads(r.stdout)['sha']
    if remote_sha != local_sha:
        print(f'远端 commit {remote_sha[:8]}  !! 与本地 {local_sha[:8]} 不一致')
        print('本地和远端会分叉。检查 message 是不是被加了尾部换行'
              '（不要用 `git log --format=%B` 取消息，它会自己补一个 \\n）。')
        sys.exit(1)
    print(f'远端 commit {remote_sha[:8]}  ✅ 与本地一致')

    # ---- 改 ref ----
    r = api(f'/repos/{repo}/git/refs/heads/main',
            {'sha': remote_sha, 'force': True}, method='PATCH')
    if r.returncode != 0:
        print('改 ref 失败:', r.stderr[:300])
        sys.exit(1)
    subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', remote_sha])
    print('✅ refs/heads/main 已更新，本地 origin/main 同步')


if __name__ == '__main__':
    main()
