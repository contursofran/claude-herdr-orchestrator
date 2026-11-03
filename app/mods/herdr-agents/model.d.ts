// Types for the few model.js builders the plugin's tests (tests/bridge.test.tsx) call.
// The app mod is plain JavaScript, so this covers only what TypeScript code imports.
export function actionFile(ms: number, rand: string): string
export function answerAction(key: string, answer: string): { action: 'answer'; key: string; answer: string }
export function doneAction(key: string): { action: 'done'; key: string }
