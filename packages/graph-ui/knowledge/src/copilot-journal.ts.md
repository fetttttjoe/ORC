# packages/graph-ui/src/copilot-journal.ts

## Why
- An exchange and the chat_opened of its chat append in one transaction, because a chat_opened without its exchange leaves an empty conversation in every chats list and an exchange without its chat is dropped by chatDigests. {5yto2sj2 @packages/graph-ui/src/copilot-journal.ts#appendCopilotExchange}
