#!/usr/bin/env python3
"""The repo-quiz guard: a settings PreToolUse hook (declared in hooks.json).

A plugin never sees the tool calls of an agent its own $.agent.spawn started
("a subagent a hook spawned through $.agent.spawn steps past that hook, as its
tool calls do"), so the guard cannot be a tool.check hook. Settings hooks from
plugins do run inside subagents, and their input names the agent's type.

It only ever denies. For the mod's own agents it refuses anything that is not
a read-only, repository-confined call; every allowed call still goes to the
session's normal permission decision. Calls from anyone else pass untouched.

Run `python3 guard.py --self-test` to check it.
"""

import json
import os
import re
import subprocess
import sys

OUR_AGENTS = {'repo-quiz:questioner', 'repo-quiz:fact-finder'}
ALWAYS_ALLOWED = {'WebSearch', 'WebFetch', 'SubagentHandback'}

READ_ONLY_START = re.compile(r'^(?:git (?:log|show|diff|blame|ls-files|grep|status)|rg|grep|ls|find|cat|head|tail|wc)(?=[ \t]|$)')
# Anywhere in the command, quoted or not. Control characters cover newline and carriage return.
FORBIDDEN_CHARS = re.compile(r'[;&|<>$`\x00-\x08\x0a-\x1f\x7f]')
# Exact words after quote removal: find's primaries that run or write things.
FORBIDDEN_WORDS = {'-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'}
# Long options that run a program or write a file. git's parse-options accepts
# unambiguous abbreviations (`git grep --open=sh`), so every prefix is refused too.
FORBIDDEN_LONG = ['pre', 'output', 'open-files-in-pager', 'ext-diff', 'hostname-bin']
PARENT_SEGMENT = re.compile(r'(^|/)\.\.(/|$)')
FLAG_PREFIX = re.compile(r'^--?[\w-]+=')


def shell_words(command):
    """Words as the shell would split them after quote removal, or None when an
    unterminated quote, a trailing backslash, or an unquoted glob, brace or
    parenthesis could smuggle in a flag or code (a glob can expand to a file
    named `--pre=sh`, a brace list to `-delete`)."""
    words, word, in_word, quote, i = [], '', False, '', 0
    while i < len(command):
        c = command[i]
        if quote == "'":
            if c == "'":
                quote = ''
            else:
                word += c
        elif quote == '"':
            if c == '"':
                quote = ''
            elif c == '\\' and i + 1 < len(command) and command[i + 1] in '"\\':
                i += 1
                word += command[i]
            else:
                word += c
        elif c in '\'"':
            quote, in_word = c, True
        elif c == '\\':
            if i + 1 >= len(command):
                return None
            i += 1
            word += command[i]
            in_word = True
        elif c in ' \t':
            if in_word:
                words.append(word)
            word, in_word = '', False
        elif c in '*?[]{}()':
            return None
        else:
            word += c
            in_word = True
        i += 1
    if quote:
        return None
    if in_word:
        words.append(word)
    return words


def is_read_only(command):
    if not READ_ONLY_START.match(command) or FORBIDDEN_CHARS.search(command):
        return False
    words = shell_words(command)
    if words is None:
        return False
    for word in words:
        if word in FORBIDDEN_WORDS:
            return False
        if word.startswith('--') and word != '--':
            name = word[2:].split('=')[0]
            if any(flag.startswith(name) for flag in FORBIDDEN_LONG):
                return False
        # A short-option bundle holding O: `git grep -O`, `-Ovim` and `-nOsh` run a pager command.
        elif word.startswith('-') and 'O' in word:
            return False
    return True


def is_inside(path, root, cwd):
    """True when `path` stays inside the repository. `~` and `..` are refused
    outright; a path that exists must resolve, symbolic links included, under
    the root's real path."""
    if not path or '~' in path or PARENT_SEGMENT.search(path):
        return False
    full = path if path.startswith('/') else os.path.join(cwd, path)
    real_root = os.path.realpath(root)
    target = os.path.realpath(full) if os.path.lexists(full) else os.path.normpath(full)
    return target == real_root or target.startswith(real_root.rstrip('/') + '/')


def words_inside(command, root, cwd):
    """Every word of the command that names a path, or exists as one, stays inside the repository."""
    for word in shell_words(command) or []:
        word = FLAG_PREFIX.sub('', word)
        if word.startswith('-') or word == '':
            continue
        names_path = word.startswith('/') or '~' in word or PARENT_SEGMENT.search(word)
        exists = os.path.lexists(os.path.join(cwd, word))
        if (names_path or exists) and not is_inside(word, root, cwd):
            return False
    return True


def repo_root(cwd):
    try:
        out = subprocess.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or cwd
    except Exception:
        return cwd


def decide(tool, tool_input, root, cwd):
    """None to let the call through to the normal permission decision, else the reason it is refused."""
    if tool in ALWAYS_ALLOWED:
        return None
    if tool == 'Read':
        path = tool_input.get('file_path', '')
        return None if is_inside(path, root, cwd) else f'repo-quiz agents may only read inside {root}.'
    if tool == 'Bash':
        command = tool_input.get('command', '')
        if not is_read_only(command):
            return 'repo-quiz agents may only run read-only commands (git log/show/diff/blame/ls-files/grep/status, rg, grep, ls, find, cat, head, tail, wc), with no pipes, redirects or unquoted globs.'
        return None if words_inside(command, root, cwd) else f'repo-quiz agents may only read inside {root}.'
    return f'repo-quiz agents may not use {tool}.'


def main():
    event = json.load(sys.stdin)
    if event.get('agent_type') not in OUR_AGENTS:
        return
    cwd = event.get('cwd') or os.getcwd()
    reason = decide(event.get('tool_name', ''), event.get('tool_input') or {}, repo_root(cwd), cwd)
    if reason:
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason}}))


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, 'app')
        os.makedirs(os.path.join(root, 'src'))
        open(os.path.join(root, 'src', 'a.ts'), 'w').close()
        secret = os.path.join(tmp, 'secret.txt')
        open(secret, 'w').close()
        os.symlink(secret, os.path.join(root, 'leak'))

        allowed = [
            ('Read', {'file_path': os.path.join(root, 'src', 'a.ts')}),
            ('Read', {'file_path': 'src/a.ts'}),
            ('Bash', {'command': 'git log -5'}),
            ('Bash', {'command': f"rg -n -e foo -e bar -g '*.ts' {root}/src"}),
            ('Bash', {'command': f"find {root} -name '*.ts'"}),
            ('Bash', {'command': "git log --format='%h %s' -- src/a.ts"}),
            ('Bash', {'command': 'cat src/a.ts'}),
            ('WebFetch', {'url': 'https://developer.mozilla.org/'}),
            ('SubagentHandback', {'message': 'report'}),
        ]
        refused = [
            ('Read', {'file_path': secret}),
            ('Read', {'file_path': os.path.join(root, 'leak')}),
            ('Read', {'file_path': '~/.ssh/id_rsa'}),
            ('Read', {'file_path': '../secret.txt'}),
            ('Bash', {'command': 'cat leak'}),
            ('Bash', {'command': f'cat {secret}'}),
            ('Bash', {'command': 'rm -rf src'}),
            ('Bash', {'command': 'rg --pre=sh x'}),
            ('Bash', {'command': 'rg --pre sh x'}),
            ('Bash', {'command': 'find . -delete'}),
            ('Bash', {'command': 'find . -ex""ec rm {} +'}),
            ('Bash', {'command': 'cat a; rm b'}),
            ('Bash', {'command': 'ls | sh'}),
            ('Bash', {'command': 'git grep -nOsh foo'}),
            ('Bash', {'command': 'git grep --open=sh foo'}),
            ('Bash', {'command': 'git -c core.pager=sh log'}),
            ('Bash', {'command': 'ls src/*'}),
            ('Bash', {'command': 'cat $(x)'}),
            ('Edit', {'file_path': 'src/a.ts'}),
            ('Write', {'file_path': 'src/b.ts'}),
        ]
        for tool, tool_input in allowed:
            assert decide(tool, tool_input, root, root) is None, (tool, tool_input)
        for tool, tool_input in refused:
            assert decide(tool, tool_input, root, root) is not None, (tool, tool_input)
    print(f'guard self-test passed: {len(allowed)} allowed, {len(refused)} refused')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
    else:
        main()
