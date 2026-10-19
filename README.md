# pi-bash-yield

A [pi](https://pi.dev) extension that stops a long-running `bash` call from holding your messages hostage.

In stock pi, a message you send while `bash` runs waits in the steering queue until the whole tool batch finishes. With this extension, the running command **steps aside**: it keeps running as a background job, the `bash` call returns at once with the job id, and your message reaches the model on the very next LLM call (images included). When the job finishes, the model gets the result automatically.

## Install

```bash
pi install npm:pi-bash-yield
```

## Behavior

| Trigger | What happens |
|---|---|
| You press Enter (steer) while `bash` runs | The command moves to the background as `bash-N`; your message is delivered next. |
| The command runs longer than the threshold (default 60 s) | Same, without any input. |
| The model passes `run_in_background: true` | The command starts as a background job immediately. |
| You press Esc | The command is killed, exactly as with the built-in tool. |
| Alt+Enter (follow-up) | No yield; the follow-up waits for the agent as usual. |

When background jobs finish, their results are sent to the model as one batched message. The message is delivered before the next LLM call if the agent is busy, or starts a new turn if it is idle.

The model also gets a `bash_job` tool with four actions: `status`, `output`, `wait`, and `kill`. `wait` stops early as soon as you send a message.

Commands run through pi's own bash implementation, so shell, `shellPath`, `shellCommandPrefix`, environment, output truncation, and exit-code reporting all match the built-in tool.

### Modes

| `ctx.mode` | Behavior |
|---|---|
| `tui` | Everything above. |
| `rpc` | Yield on an explicit steer only. Threshold and `run_in_background` are off, because pi-subagents children also run in rpc mode. A child never backgrounds work on its own, but a job created by an explicit steer can still be running when the run settles. |
| `print`, `json` | Identical to the built-in `bash`. |

Calls nested inside another tool (for example codemode scripts) are never backgrounded.

### Lifecycle

Background jobs belong to the session. On `/reload`, `/new`, `/resume`, fork, or quit, they are killed (process group, `SIGKILL`). pi itself also kills any remaining tracked children on exit.

Cleanup covers the command's process group while its shell is alive. The built-in `bash` has the same limit. Processes that a command detaches on its own (`cmd &` followed by the shell exiting, `nohup`, `setsid`, daemons) are not tracked. Use `run_in_background` instead.

If Esc clears pi's queue while a completion notice is still waiting there, the notice is attached to your next prompt rather than waking the agent again.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--bash-yield-threshold <seconds>` (`0` = never) | `PI_BASH_YIELD_THRESHOLD` | `60` |
| `--bash-yield-disable` | `PI_BASH_YIELD_DISABLE=1` | off |

## Development

```bash
npm install
npm run check        # typecheck + unit/integration tests + e2e against the installed `pi`
pi -e ./src/index.ts # try it locally
```

The e2e tests (`test/e2e`) use a scripted faux model (`test/e2e/faux-provider.ts`), so they need no API key:

- `pi.test.mjs` drives `pi --mode rpc` and `pi -p`. It covers steering with an image, completion notices, `new_session` cleanup, and headless runs.
- `tui.test.mjs` drives the interactive TUI through tmux and is skipped when tmux is missing. It covers steering with Enter, Esc kill, the threshold, and `/reload` cleanup.

### Manual check

One step is not automated: attaching an image in the TUI editor.

1. Run `pi -e ./src/index.ts` with a real model and ask for `sleep 120`.
2. Paste an image into a message and press Enter.

Expected: the model describes the image right away.

## License

MIT
