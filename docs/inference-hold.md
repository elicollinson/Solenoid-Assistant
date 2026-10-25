# Inference hold

The assistant's model runs on local hardware (LM Studio on the Mac Studio) that
other projects also use. An inference hold lets those projects borrow the host:
while a hold is live, every new workflow run waits in the queue, whether the
schedule, the Run button, or chat started it, and the screenshot source
consumer pauses. When the last hold is released, the worker runs the queue
oldest first, one run at a time.

A hold queues work; it does not stop it. A run already going when the hold is
placed finishes. Chat and voice replies are not held.

## Behavior

- **Named holds.** Each caller passes a `holder` name. Two overlapping scripts
  each release only their own hold; the queue drains once none remain.
- **Holds expire.** Default 360 minutes, maximum 1440. A script that crashes
  before releasing delays queued work; it cannot pause the assistant forever.
  Holding again with the same name renews the hold, so a long job can re-hold
  every few hours.
- **Requests are kept, and identical ones fold.** A scheduled firing, a Run
  press, or a run asked for in chat during a hold becomes a `queued` run on the
  Workflows screen, with any guidance from chat kept for when it starts. If the
  same workflow already has a queued run with the same arguments and guidance,
  the new one folds into it: an hourly rule over a six-hour eval catches up
  once, not six times.
- **Queued runs are re-checked when they leave the queue.** A workflow paused
  in the meantime is written down as `cancelled`, with the reason. A queued run
  can be stopped like a running one.

## API

All routes need `Authorization: Bearer $INFERENCE_HOLD_TOKEN`, which is at
least 32 characters. While the token is unset, every route answers 401.

| Method and path | Body | Effect |
| --- | --- | --- |
| `GET /api/inference/hold` | | `{ held, holds: [{holder, reason, since, expiresAt}], queued }` |
| `POST /api/inference/hold` | `{ holder, minutes?, reason? }` | Hold or renew; returns the status |
| `POST /api/inference/release` | `{ holder }` | Release that holder's hold; returns the status |

`holder` allows letters, digits and `. _ : @ -`, up to 80 characters.

## From another project

Copy `scripts/inference-hold` into the project and wrap the job with it:

```sh
export SOLENOID_INFERENCE_HOLD_TOKEN=...   # from your password manager
scripts/inference-hold run --holder evals:gemma --reason "nightly sweep" -- python run_evals.py
```

`run` holds, runs the command, and releases when the command exits, including
on failure or Ctrl-C. The command's exit status is passed through. To manage a
hold by hand, use `hold` and `release` separately, or `status` to check.

`SOLENOID_URL` defaults to `https://solenoid.home.arpa`. If the machine does not
trust the mini-cloud CA, point `CURL_CA_BUNDLE` at the CA root.
