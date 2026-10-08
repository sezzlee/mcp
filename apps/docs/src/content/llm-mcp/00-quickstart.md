# Hand bounded work to a local model

`@sezzlee/llm-mcp` lets a planning agent, such as Codex or Claude Code, hand bounded language work
to a model on your own [Ollama](https://ollama.com). The agent passes a file path; the server reads
the file, and only the model's short answer enters the agent's context.

You need Node.js 22 or later, `jq` and [Ollama](https://ollama.com/download) running.

## 1. Pull a model

Any Ollama model that can follow a JSON schema works. `qwen3:8b` is a good start on a machine with
8 GB of GPU memory:

```sh
ollama pull qwen3:8b
```

## 2. Pick a folder

The server reads files only inside its workspace, and writes only into an output folder inside it.
To follow along, create one and save [meeting-notes.txt](/samples/llm-mcp/meeting-notes.txt),
[tickets.csv](/samples/llm-mcp/tickets.csv) and
[operations-2026.txt](/samples/llm-mcp/operations-2026.txt) into it:

```sh
mkdir -p ~/sezzlee-llm
```

## 3. Add the server to your client

Pass the workspace as an **absolute** path and name the model. Only the model is required; a client
passes the server none of its own environment, so every setting goes in `env`.

:::tabs

```sh title="Claude Code"
claude mcp add local -e SEZZLEE_LLM_MODEL=qwen3:8b -e SEZZLEE_LLM_ROOT=/Users/you/sezzlee-llm -- npx -y @sezzlee/llm-mcp
```

```toml title="Codex"
[mcp_servers.local]
command = "npx"
args = ["-y", "@sezzlee/llm-mcp"]
default_tools_approval_mode = "auto"
tool_timeout_sec = 900

[mcp_servers.local.env]
SEZZLEE_LLM_MODEL = "qwen3:8b"
SEZZLEE_LLM_ROOT = "/Users/you/sezzlee-llm"
```

```json title="Claude Desktop"
{
  "mcpServers": {
    "local": {
      "command": "npx",
      "args": ["-y", "@sezzlee/llm-mcp"],
      "env": {
        "SEZZLEE_LLM_MODEL": "qwen3:8b",
        "SEZZLEE_LLM_ROOT": "/Users/you/sezzlee-llm"
      }
    }
  }
}
```

```json title="Cursor"
{
  "mcpServers": {
    "local": {
      "command": "npx",
      "args": ["-y", "@sezzlee/llm-mcp"],
      "env": {
        "SEZZLEE_LLM_MODEL": "qwen3:8b",
        "SEZZLEE_LLM_ROOT": "/Users/you/sezzlee-llm"
      }
    }
  }
}
```

```json title="VS Code"
{
  "servers": {
    "local": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sezzlee/llm-mcp"],
      "env": {
        "SEZZLEE_LLM_MODEL": "qwen3:8b",
        "SEZZLEE_LLM_ROOT": "/Users/you/sezzlee-llm"
      }
    }
  }
}
```

:::

Codex goes in `~/.codex/config.toml`, Claude Desktop in `claude_desktop_config.json` (**Settings →
Developer → Edit Config**, then restart), Cursor in `.cursor/mcp.json` and VS Code in
`.vscode/mcp.json`. Without `SEZZLEE_LLM_ROOT`, the workspace is the folder the client starts the
server in.

The Codex timeout covers the wait behind other calls and a long labelling run. These configurations
were not loaded into the clients for this page: the Claude Code command was checked against
`claude mcp add --help`, the Codex block follows the configuration a Codex-driving host generates,
and the JSON follows each client's documented format.

:::details[If the server does not start or the agent cannot call it]

A missing model or an invalid number stops the server at startup with a message naming the
variable. An Ollama that is not running does not: the server starts, `local_status` reports
`reachable: false`, and a task fails with `backend_unavailable`. Start Ollama and ask again. To
check the setup, ask the agent whether the local model is available; it should call `local_status`.

Under `approval_policy = "never"`, Codex refuses a tool call that asks for approval outright.
`default_tools_approval_mode = "auto"` lets it decide from each tool's annotations instead.

:::

## 4. Hand over a first task

Ask the agent: **Summarise meeting-notes.txt for the team lead.**

Expect one `local_task` call with `kind` set to `summarize` and the file's path. The server reads the
notes and the local model summarises them. The agent receives the summary and nothing else.

## See what the agent receives

The recipes call the tools the way an agent does, through the MCP Inspector, so you can see each
answer exactly. Install the server once:

```sh
npm install -g @sezzlee/llm-mcp
```

Name the model you pulled:

```text
export SEZZLEE_LLM_MODEL=qwen3:8b
```

Then define this helper in your shell. The Inspector passes the server none of your environment, so
the helper hands over the model and the workspace with `-e`:

```sh
llm() {
  npx -y @modelcontextprotocol/inspector --cli sezzlee-llm -- \
    -e SEZZLEE_LLM_MODEL="$SEZZLEE_LLM_MODEL" -e SEZZLEE_LLM_ROOT="$HOME/sezzlee-llm" \
    --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

This checks the model:

```sh
llm local_status | jq '{model, reachable, contextTokens, inputBudgetTokens}'
```

```json
{
  "model": "qwen3.8:latest",
  "reachable": true,
  "contextTokens": 16384,
  "inputBudgetTokens": 7372
}
```

`inputBudgetTokens` is the most input one call may send: 45% of the 16,384-token window the server
asks Ollama for, leaving room for the instructions and the answer. The answers in these docs were
produced with `qwen3.8:latest`, a 27-billion-parameter Qwen model, so yours will read differently.
Their shape is the same whichever model you use.

## What it gives the agent

- **`local_task`** runs one task on the local model: `summarize`, `extract`, `classify`, `transform`
  or `free`, over short text or up to eight files. With a JSON Schema the answer is JSON.
- **`local_map`** labels every row of a CSV file with one of your labels and writes a labelled copy.
  The agent sees counts and a few sample rows, never the file.
- **`local_status`** says whether the model host answers and how much input one call may carry.

The local model gets one instruction and one input and cannot call tools. The server never cuts an
input to fit: one the window cannot hold is split or refused.

:::details[When delegating pays off]

The local model costs nothing per token and keeps text out of the agent's context. It is also slower
and less capable than the agent. Measured with Codex against a 16,384-token window:

- **Rows with clear cues:** a script written by the agent labelled 400 rows in 53 seconds; delegating
  was as accurate and took 155. When a keyword or a column decides, use a script.
- **Rows without cues:** a vague instruction labelled 2 of 14 groups correctly. One that named the cues
  from a sample, with the returned samples checked, got 14 of 14. The instruction is the work.
- **Long documents:** Codex alone read the first 240 lines of each of 17 documents. Delegating read
  every one to the end, and the queue cleared in 157 seconds.

Pointing the agent at the model directly did not work: Codex's own instructions run to about 37,000
tokens, which do not fit a 16k window. An MCP server runs outside the agent's sandbox, and the local
model receives only the prompt for one task.

:::

:::details[Why it cannot read outside the workspace]

At startup the server resolves its workspace to a real path. Every file argument is checked twice,
as given and after following symbolic links. A `..` that climbs out, an absolute path elsewhere, or
a link that leads outside is refused with `outside_workspace`. Errors show the workspace as `.`, so
an answer never reveals where it sits on disk. A file must be UTF-8 text, or it is refused with
`not_text`.

`local_map` is the only tool that writes, and it only adds files: new, named by the server, with a
fixed `.csv` extension, inside the output folder. It never replaces or deletes a file, and the input
is never changed. The files the tools read go to the host in `SEZZLEE_LLM_BASE_URL` and nowhere
else. By default that is your own machine.

:::
