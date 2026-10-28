"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var testing_1 = require("claude-code/testing");
var defaults_1 = require("../hooks/defaults");
var harness_1 = require("./harness");
// The outbox (outbox.ts): the prompts for the coordinator that come close together go out as one,
// after a quiet BATCH_MS and once the coordinator's turn has ended. The batch's tick checks read
// RESULT.md every 3 s, so a report written now is delivered within 3 s and sent BATCH_MS after that.
var INBOX = '/home/t/.herdr-agents/board/session-1234.actions';
var turnEnd = function (turnId) { return ({ turnId: turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }); };
(0, testing_1.test)('two reports that land together reach the coordinator as one prompt, with one worker count', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, _b, tokenA, tokenB;
    var _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a', 'w-b'])];
            case 2:
                _d.sent();
                _b = typed.map(function (t) { var _a; return (_a = t.match(/<!-- report (\S+) -->/)) === null || _a === void 0 ? void 0 : _a[1]; }), tokenA = _b[0], tokenB = _b[1];
                files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = "<!-- report ".concat(tokenA, " -->\nReviewed: approve.");
                files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = "<!-- report ".concat(tokenB, " -->\nReviewed: two blockers.");
                return [4 /*yield*/, clock.advance(10000)];
            case 3:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                // Both elements in one prompt. Their order is the order the tick delivered them in, which the test does not fix.
                (0, testing_1.expect)(submitted[0]).toMatch(/<herdr-agent name="w-a"/);
                (0, testing_1.expect)(submitted[0]).toMatch(/<herdr-agent name="w-b"/);
                (0, testing_1.expect)((_c = submitted[0]) === null || _c === void 0 ? void 0 : _c.match(/workers working/g)).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a', 'w-b'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a report that lands while a coordinator turn runs waits for the turn to end, and joins the next batch', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, _b, tokenA, tokenB;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _c.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a', 'w-b'])];
            case 2:
                _c.sent();
                _b = typed.map(function (t) { var _a; return (_a = t.match(/<!-- report (\S+) -->/)) === null || _a === void 0 ? void 0 : _a[1]; }), tokenA = _b[0], tokenB = _b[1];
                return [4 /*yield*/, $.turn.start({ text: 'Check the reports.', turnId: 't1' })];
            case 3:
                _c.sent();
                files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = "<!-- report ".concat(tokenA, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(10000)];
            case 4:
                _c.sent();
                return [4 /*yield*/, clock.advance(30000)
                    // Held while the turn runs: a prompt sent now would only queue behind it.
                ];
            case 5:
                _c.sent();
                // Held while the turn runs: a prompt sent now would only queue behind it.
                (0, testing_1.expect)(submitted).toEqual([]);
                return [4 /*yield*/, $.turn.complete(turnEnd('t1'))];
            case 6:
                _c.sent();
                files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = "<!-- report ".concat(tokenB, " -->\nReviewed: two blockers.");
                return [4 /*yield*/, clock.advance(10000)];
            case 7:
                _c.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/<herdr-agent name="w-a"/);
                (0, testing_1.expect)(submitted[0]).toMatch(/<herdr-agent name="w-b"/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a', 'w-b'])];
            case 8:
                _c.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a held batch survives a reload and goes out once; other sessions' copies that are days old are removed", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var held, stale, recent, _a, clock, submitted, store;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                held = {
                    at: 990000,
                    items: [{ text: '<herdr-agent name="w-x" profile="builder" status="done">\nDone.\n</herdr-agent>', report: true }],
                };
                stale = { at: 1000000 - defaults_1.JOBS_KEEP_MS - 1, items: [{ text: 'an old answer' }] };
                recent = { at: 999000, items: [{ text: 'a recent answer' }] };
                return [4 /*yield*/, (0, harness_1.start)($, on, {}, { 'outbox:session-1234': held, 'outbox:old': stale, 'outbox:recent': recent })];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, store = _a.store;
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 2:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-agent name="w-x" profile="builder" status="done">\nDone\.\n<\/herdr-agent>/);
                (0, testing_1.expect)(store.has('outbox:session-1234')).toBe(false);
                (0, testing_1.expect)(store.has('outbox:old')).toBe(false);
                (0, testing_1.expect)(store.get('outbox:recent')).toEqual(recent);
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 3:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a prompt the session refuses is kept, and goes out with the next batch', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, refuse, _b, tokenA, tokenB;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _c.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, refuse = _a.refuse;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a', 'w-b'])];
            case 2:
                _c.sent();
                _b = typed.map(function (t) { var _a; return (_a = t.match(/<!-- report (\S+) -->/)) === null || _a === void 0 ? void 0 : _a[1]; }), tokenA = _b[0], tokenB = _b[1];
                files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = "<!-- report ".concat(tokenA, " -->\nReviewed: approve.");
                refuse.next = 1;
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _c.sent();
                (0, testing_1.expect)(submitted).toEqual([]);
                files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = "<!-- report ".concat(tokenB, " -->\nReviewed: two blockers.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 4:
                _c.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-agent name="w-a"[\s\S]*\n\n<herdr-agent name="w-b"/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a', 'w-b'])];
            case 5:
                _c.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('an owner answer and a report that arrive together go out as one prompt', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a'])];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })];
            case 3:
                _d.sent();
                files["".concat(INBOX, "/1-answer.json")] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' });
                files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-agent name="w-a"[\s\S]*\n\n<herdr-decision id="D1" from="p-1">[\s\S]*The owner chose: Yes/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('an owner answer that goes out alone carries no worker count', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, files;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, files = _a.files;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })];
            case 2:
                _b.sent();
                files["".concat(INBOX, "/1-answer.json")] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' });
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-decision id="D1" from="p-1">/);
                (0, testing_1.expect)(submitted[0]).not.toContain('workers working');
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a wrap-up goes out at once, not in the batch: the answer waiting for its batch comes after it', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, files;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, files = _a.files;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a'])];
            case 2:
                _b.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })];
            case 3:
                _b.sent();
                files["".concat(INBOX, "/1-answer.json")] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' });
                files["".concat(INBOX, "/2-wrap.json")] = JSON.stringify({ action: 'wrapUp', on: true });
                return [4 /*yield*/, clock.advance(3000)];
            case 4:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-context>The owner is wrapping up/);
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(2);
                (0, testing_1.expect)(submitted[1]).toMatch(/^<herdr-decision id="D1" from="p-1">/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a'])];
            case 6:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a loop that wakes after a reload emptied $.state sends no empty prompt; the held batch goes out once after the restore', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var lost, _a, clock, submitted, files, store;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                lost = false;
                // The state as a reload leaves it: empty, at the version the engine holds.
                on('state.get', function (_, e, next) { return __awaiter(void 0, void 0, void 0, function () {
                    var read;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, next(e)];
                            case 1:
                                read = _a.sent();
                                if (!read.value || !lost || e.key !== 'outbox')
                                    return [2 /*return*/, read];
                                return [2 /*return*/, { value: { value: [], version: read.value.version } }];
                        }
                    });
                }); });
                return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, files = _a.files, store = _a.store;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })];
            case 2:
                _b.sent();
                files["".concat(INBOX, "/1-answer.json")] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' });
                return [4 /*yield*/, clock.advance(3000)];
            case 3:
                _b.sent();
                lost = true;
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _b.sent();
                (0, testing_1.expect)(submitted).toEqual([]);
                // Nothing was sent, so the copy in the store is still there for the restore.
                (0, testing_1.expect)(store.has('outbox:session-1234')).toBe(true);
                lost = false;
                // The reload's start restores the copy in the store, and its batch goes out after the quiet.
                return [4 /*yield*/, $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })];
            case 5:
                // The reload's start restores the copy in the store, and its batch goes out after the quiet.
                _b.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS + 3000)];
            case 6:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-decision id="D1" from="p-1">/);
                (0, testing_1.expect)(store.has('outbox:session-1234')).toBe(false);
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 7:
                _b.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a prompt the session refused goes out on the next sweep, with no new report or turn end', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, refuse, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, refuse = _a.refuse;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a'])];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                refuse.next = 1;
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _d.sent();
                (0, testing_1.expect)(submitted).toEqual([]);
                // Nothing else comes in before the sweep at 60 s: it is what tries again.
                return [4 /*yield*/, clock.advance(50000)];
            case 4:
                // Nothing else comes in before the sweep at 60 s: it is what tries again.
                _d.sent();
                (0, testing_1.expect)(submitted).toEqual([]);
                return [4 /*yield*/, clock.advance(10000)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                (0, testing_1.expect)(submitted[0]).toMatch(/^<herdr-agent name="w-a"/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a'])];
            case 6:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a turn whose decision ping throws still ends, so a report that comes later goes out', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var unreadable, _a, clock, submitted, typed, files, _b, tokenA, tokenB;
    var _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0:
                unreadable = false;
                on('state.get', function (_, e, next) { return __awaiter(void 0, void 0, void 0, function () {
                    var read;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, next(e)];
                            case 1:
                                read = _a.sent();
                                if (!read.value || !unreadable || e.key !== 'decisions')
                                    return [2 /*return*/, read];
                                return [2 /*return*/, { value: { value: null, version: read.value.version } }];
                        }
                    });
                }); });
                return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-a', 'w-b'])];
            case 2:
                _d.sent();
                _b = typed.map(function (t) { var _a; return (_a = t.match(/<!-- report (\S+) -->/)) === null || _a === void 0 ? void 0 : _a[1]; }), tokenA = _b[0], tokenB = _b[1];
                files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = "<!-- report ".concat(tokenA, " -->\nDECISION: Ship it today? | Yes | No");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _d.sent();
                (0, testing_1.expect)(submitted).toHaveLength(1);
                // The coordinator's turn reads the report; its end pings the person for the question, and the ping throws
                // (the engine skips the turn.complete hook, so the turn still ends).
                return [4 /*yield*/, $.turn.start({ text: (_c = submitted[0]) !== null && _c !== void 0 ? _c : '', turnId: 't1' })];
            case 4:
                // The coordinator's turn reads the report; its end pings the person for the question, and the ping throws
                // (the engine skips the turn.complete hook, so the turn still ends).
                _d.sent();
                unreadable = true;
                return [4 /*yield*/, $.turn.complete(turnEnd('t1'))];
            case 5:
                _d.sent();
                unreadable = false;
                files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = "<!-- report ".concat(tokenB, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 6:
                _d.sent();
                (0, testing_1.expect)(submitted).toHaveLength(2);
                (0, testing_1.expect)(submitted[1]).toMatch(/^<herdr-agent name="w-b"/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-a', 'w-b'])];
            case 7:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
