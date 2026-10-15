# lukes-claudecode-mods

A collection of Claude Code mods that I built. Each mod changes how Claude Code looks or behaves, with panes, prompts and hooks.

## Mods

### [repo-quiz](./repo-quiz)

After each of Claude's replies, a sidebar asks you an interview-style question about the repository that you work in. Sometimes it shows a short "Did you know?" fact instead. Each answer and each fact cites your code and official documentation.

To install it, run this command in a Claude Code terminal session:

```
/plugin install repo-quiz --marketplace lukeismith/lukes-claudecode-mods
```

Answer `y` to add the marketplace, then choose the user scope. [repo-quiz/README.md](./repo-quiz/README.md) explains how it works, its keys, its settings and its cost.

## License

The mods in this repository are free software under the GNU General Public License, version 3 or any later version. See [LICENSE](./LICENSE).
