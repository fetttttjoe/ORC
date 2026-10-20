# packages/ui-core/src/open-questions.ts

## Why
- openQuestions folds the whole log because a windowed fold loses older questions and a task parked on a human would read as idle; measured over a 1012-event log a whole fold costs 0.007 to 0.02 ms, so refolding per append is cheap. {20sddv2z @packages/ui-core/src/open-questions.ts#openQuestions}
- openQuestions leaves which topics are open to openFeedbackTopics, so the question an operator sees and the topic a reply closes cannot drift, and it keeps the payload's own question text because summary lines clip it at 120 characters. {ynw0b26z @packages/ui-core/src/open-questions.ts#openQuestions}
