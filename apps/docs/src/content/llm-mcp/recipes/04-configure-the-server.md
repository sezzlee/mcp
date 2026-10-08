# Configure the server

The server takes its settings from environment variables. Only the model is required; this page
covers the rest, including the context window, how long the model stays loaded and how long a call
may take.

## The variables

| Variable                 | Default                  | Meaning                                                            |
| ------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `SEZZLEE_LLM_MODEL`      | required                 | The Ollama model name, as `ollama list` shows it.                  |
| `SEZZLEE_LLM_BASE_URL`   | `http://127.0.0.1:11434` | The Ollama host.                                                   |
| `SEZZLEE_LLM_ROOT`       | the working directory    | The workspace every file argument is resolved against.             |
| `SEZZLEE_LLM_OUTPUT_DIR` | `.llm-mcp/out`           | Where `local_map` writes, relative to the workspace and inside it. |
| `SEZZLEE_LLM_NUM_CTX`    | `16384`                  | The context window asked of Ollama, at least 4096.                 |
| `SEZZLEE_LLM_KEEP_ALIVE` | `30m`                    | How long Ollama keeps the model loaded after a call.               |
| `SEZZLEE_LLM_TIMEOUT_MS` | `300000`                 | Time one request to the model may take, once it leaves the queue.  |

Set them in the client's `env` block, as in the [Quickstart](/docs/llm-mcp/quickstart). Right after
it starts, the server asks Ollama to load the model, so the first real call does not pay for the
load.

## Use an Ollama on another machine

Set `SEZZLEE_LLM_BASE_URL` to its address, for example `http://10.0.0.5:11434`. The files the tools
read are sent there, so use a host you trust with them.

## Size the context window

`SEZZLEE_LLM_NUM_CTX` sets the window:

```json
{
  "env": {
    "SEZZLEE_LLM_MODEL": "qwen3:8b",
    "SEZZLEE_LLM_NUM_CTX": "32768"
  }
}
```

Set it to what your GPU actually holds for the model, not to the largest the model supports. Ollama
drops the start of a prompt larger than the window it could allocate, and the server's input budget
is derived from this number, so one that is too large makes the server send inputs Ollama quietly
cuts.

Of the window, 45% is the input budget and 40% is the most the answer may use; the rest is left for
the server's own instructions. The server estimates 1.8 characters per token, which is about right
for Turkish and cautious for English, where a token is closer to four characters:

| `SEZZLEE_LLM_NUM_CTX` | Input budget  | About this much text | Answer at most |
| --------------------- | ------------- | -------------------- | -------------- |
| 4,096                 | 1,843 tokens  | 3,300 characters     | 1,638 tokens   |
| 16,384                | 7,372 tokens  | 13,300 characters    | 6,553 tokens   |
| 32,768                | 14,745 tokens | 26,500 characters    | 13,107 tokens  |

`local_status` reports `contextTokens` and `inputBudgetTokens` for the running server. A larger
window lets `classify`, `transform` and `free` take longer inputs and lets `summarize` and `extract`
split into fewer chunks. It also takes more GPU memory and makes each call slower.

## Keep the model loaded

Loading a model takes seconds to minutes, so an agent that delegates in bursts is faster with the
model kept warm. `SEZZLEE_LLM_KEEP_ALIVE` is `30m` by default.

## Give slow calls time

`SEZZLEE_LLM_TIMEOUT_MS`, five minutes by default, bounds one request to the model from the moment it
leaves the queue. A request that runs out fails with `backend_unavailable`. Calls run one at a time,
so the client's own tool timeout has to cover the wait behind other calls as well. That is why the
Codex configuration in the [Quickstart](/docs/llm-mcp/quickstart) allows 900 seconds, and a
labelling run over 2,000 rows takes about nine minutes by itself.

`local_status` reports how many calls are waiting. It does not wait itself, so a status question
never queues behind a long job.

:::details[Why local calls wait in one queue]

An agent that delegates tends to do it in bursts: Codex was measured firing 17 `local_task` calls at
once. The server sends them to the model one at a time. One GPU interleaves parallel requests rather
than running them side by side: four sent together finished only 1.1 times faster than the same four
sent in turn, each taking about four times as long.

Every call has a timeout, so seventeen in parallel would each take seventeen times longer and run
out of time together. In a queue, each call runs at full speed when its turn comes, and the first
answers return while later calls wait. The 17 documents cleared the queue in 157 seconds, and none
timed out. More parallelism would help only with more than one GPU or host, which would be a
different backend with its own queue, not a larger number here.

:::
