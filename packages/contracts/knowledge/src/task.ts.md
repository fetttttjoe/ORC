# packages/contracts/src/task.ts

## Facts
- TaskNode.type is z.enum(TaskType) (packages/contracts/src/task.ts), with members TaskType.generic, TaskType.grounded and TaskType.split; createTask/createTaskIn's input.type is typed TaskType, and every caller across kernel, cli and ui-core tests passes a TaskType member rather than a raw string literal. {8tyyjnjz @packages/contracts/src/task.ts#TaskType #task-type #task-type-is-a-string-enum}
