# add-wxo-chat

Add a [watsonx Orchestrate](https://www.ibm.com/products/watsonx-orchestrate) embedded chat to your CEN Starter app.

## When to use

Ask Bob to **"add a WXO chat"** or **"embed watsonx Orchestrate"** whenever you want to surface an AI agent directly inside your app — without building a custom chat UI from scratch.

## How it works

Bob asks you two questions: which layout you want and whether you need a fullscreen toggle. Then it scaffolds everything — components, a `/wxo` route, nav link, and environment variables — and verifies the result compiles cleanly.

Four layout options are available:

| Layout | Best for |
|---|---|
| `float` | Chat as a supplementary tool alongside existing pages |
| `custom` | A branded experience with a guide panel next to the chat |
| `fullscreen` | Immersive, chat-first experiences |
| `docview` | Workflows where the agent surfaces documents the user reads inline |

## Benefits

- **No boilerplate** — all components, types, event handlers, and config are generated for you.
- **No new dependencies** — uses only packages already in the project.
- **Production-ready patterns** — covers anonymous and authenticated access, multi-agent setups, React Strict Mode safety, and float layout quirks out of the box.
