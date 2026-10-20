# packages/graph-ui/src/server.ts

## Why
- Actions that execute run only against the project this server started in, because they need the runtime that lives there; newProject, deleteProject and reply name their own target and execute nothing, so a foreign chat may use them. {nvto176s @packages/graph-ui/src/server.ts#CROSS_PROJECT_ACTIONS}
- A request must carry a loopback Host header, because a DNS-rebinding page reaches the loopback server under its own hostname, which defeats both the localhost bind and the CSRF token. {b9riuiiu @packages/graph-ui/src/server.ts#startGraphUi}
- The project query param is resolved against the projects that exist, because sessionFor caches a session (a Postgres pool plus a LISTEN client) per distinct string and the GET routes carry no token. {dsbre9tb @packages/graph-ui/src/server.ts#startGraphUi}
