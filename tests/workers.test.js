"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var testing_1 = require("claude-code/testing");
var defaults_1 = require("../hooks/defaults");
var harness_1 = require("./harness");
// Starting workers: the rules spawn applies, from the built-in profiles in effect. A report
// reaches the coordinator once its batch goes out (see outbox.ts), BATCH_MS after it.
(0, testing_1.test)('a turned-off built-in cannot start, and the rules name what replaces it', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var clock, denied, again, guide;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, {
                    disable: ['reviewer', 'debugger', 'builder'],
                    profiles: { builder: { kind: 'claude', args: ['--model', 'sonnet'] } },
                })];
            case 1:
                clock = (_a.sent()).clock;
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__spawn',
                        worker: 'w-rev',
                        profile: 'reviewer',
                        cwd: '/repo/wt',
                        task: 'x',
                    })];
            case 2:
                denied = _a.sent();
                (0, testing_1.expect)(JSON.stringify(denied)).toMatch(/reviewer is turned off/);
                // The builder cannot be turned off; a second writer in its worktree waits until the first is stopped.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'x' })];
            case 3:
                // The builder cannot be turned off; a second writer in its worktree waits until the first is stopped.
                _a.sent();
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__spawn',
                        worker: 'w-two',
                        profile: 'builder',
                        cwd: '/repo/wt',
                        task: 'y',
                    })];
            case 4:
                again = _a.sent();
                (0, testing_1.expect)(JSON.stringify(again)).toMatch(/stop it first/);
                (0, testing_1.expect)(JSON.stringify(again)).toMatch(/After two failed fix rounds, ask the owner with ask_owner instead/);
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-help')];
            case 5:
                guide = (_a.sent()).text;
                (0, testing_1.expect)(guide).toMatch(/    builder .* · customized\n/);
                (0, testing_1.expect)(guide).toMatch(/    reviewer .* · off\n/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 6:
                _a.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a message after a report with DECISION lines reaches the worker as new text, not TASK.md again', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, dir, token, before, empty, answer, sent, saved, long, pointer;
    var _b, _c, _d, _e, _f, _g, _h, _j;
    return __generator(this, function (_k) {
        switch (_k.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _k.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-done', profile: 'builder', cwd: '/repo/wt', task: 'Fix the nits.' })
                    // herdr's wait answers at once for a worker that is already done: the mod sees that before the report is written.
                ];
            case 2:
                _k.sent();
                // herdr's wait answers at once for a worker that is already done: the mod sees that before the report is written.
                return [4 /*yield*/, clock.settle()];
            case 3:
                // herdr's wait answers at once for a worker that is already done: the mod sees that before the report is written.
                _k.sent();
                dir = '/repo/wt/.herdr-agents/w-done';
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files["".concat(dir, "/RESULT.md")] = "<!-- report ".concat(token, " -->\nStopped.\nDECISION: [Edit scope] May I edit CI scripts? | Yes (recommended) | No");
                return [4 /*yield*/, finish('w-done')];
            case 4:
                _k.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _k.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/Pinned for the owner as D1/);
                before = typed.length;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: '  \n ' })];
            case 6:
                empty = _k.sent();
                (0, testing_1.expect)(JSON.stringify(empty)).toMatch(/the message is empty/);
                (0, testing_1.expect)(typed.length).toBe(before);
                answer = 'D1 = yes, edit the CI scripts.\nKeep "head -n 1" and its `$1` as they are.';
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: "\n".concat(answer, "\n") })
                    // The brief stays as it was; the answer is typed in and kept in a file of its own.
                ];
            case 7:
                _k.sent();
                // The brief stays as it was; the answer is typed in and kept in a file of its own.
                (0, testing_1.expect)(files["".concat(dir, "/TASK.md")]).toBe('Fix the nits.');
                sent = (_d = typed.at(-1)) !== null && _d !== void 0 ? _d : '';
                (0, testing_1.expect)(sent).toContain(answer);
                (0, testing_1.expect)(sent).not.toContain('TASK.md');
                saved = (_e = sent.match(/also saved in (\S+\/MESSAGE-\d+-\w+\.md)/)) === null || _e === void 0 ? void 0 : _e[1];
                (0, testing_1.expect)(saved && files[saved]).toBe(answer);
                // A long message is only pointed to, in a file the worker has not read yet.
                files["".concat(dir, "/RESULT.md")] = "<!-- report ".concat((_g = (_f = typed.at(-1)) === null || _f === void 0 ? void 0 : _f.match(/<!-- report (\S+) -->/)) === null || _g === void 0 ? void 0 : _g[1], " -->\nDone.");
                return [4 /*yield*/, finish('w-done')];
            case 8:
                _k.sent();
                long = 'x'.repeat(5000);
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: long })];
            case 9:
                _k.sent();
                pointer = (_j = (_h = typed.at(-1)) === null || _h === void 0 ? void 0 : _h.match(/New message from your coordinator in (\S+\/MESSAGE-\d+-\w+\.md), a file you have not read yet/)) === null || _j === void 0 ? void 0 : _j[1];
                (0, testing_1.expect)(pointer && files[pointer]).toBe(long);
                (0, testing_1.expect)(typed.at(-1)).not.toContain(long);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-done'])];
            case 10:
                _k.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a DECISION line that says none is not pinned for the owner', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, token, report;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _e.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-none', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _e.sent();
                return [4 /*yield*/, clock.settle()];
            case 3:
                _e.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-none/RESULT.md'] =
                    "<!-- report ".concat(token, " -->\nOpened PR #4.\nDECISION: none. No owner decision is needed for this PR.\n**decision:** None\nDECISION: [Port] Which port? | 5173 (recommended) | 8080");
                return [4 /*yield*/, finish('w-none')];
            case 4:
                _e.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _e.sent();
                report = (_d = submitted.at(-1)) !== null && _d !== void 0 ? _d : '';
                (0, testing_1.expect)(report).toMatch(/Pinned for the owner as D1/);
                (0, testing_1.expect)(report).not.toMatch(/D2/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-none'])];
            case 6:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a prompt that starts no work is typed again, and a worker it never reaches is reported blocked', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, stalls, finish, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)
                // The first try stalls; the second starts work, so the worker runs on and reports.
            ];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, stalls = _a.stalls, finish = _a.finish;
                // The first try stalls; the second starts work, so the worker runs on and reports.
                stalls['w-late'] = 1;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-late', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                return [4 /*yield*/, clock.settle()];
            case 3:
                _d.sent();
                (0, testing_1.expect)(typed).toHaveLength(2);
                (0, testing_1.expect)(typed[1]).toBe(typed[0]);
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-late/RESULT.md'] = "<!-- report ".concat(token, " -->\nDone.");
                return [4 /*yield*/, finish('w-late')];
            case 4:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/<herdr-agent name="w-late" profile="builder" status="done">\nDone\./);
                // Every try stalls: reported blocked at once, not idle five minutes later.
                stalls['w-lost'] = 3;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })];
            case 6:
                _d.sent();
                (0, testing_1.expect)(typed).toHaveLength(5);
                return [4 /*yield*/, clock.advance(10000)];
            case 7:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 8:
                _d.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/status="blocked">\nThe worker stopped \(its prompt was not delivered: no work started after 3 tries\)/);
                return [2 /*return*/];
        }
    });
}); });
// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
(0, testing_1.test)("a reported worker's tab closes once it has sat idle, unless its question is still open", { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, closed, files, report, late;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, typed = _a.typed, closed = _a.closed, files = _a.files;
                report = function (worker, text) { return __awaiter(void 0, void 0, void 0, function () {
                    var token;
                    var _a, _b;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0: return [4 /*yield*/, (0, harness_1.spawn)($, [worker])];
                            case 1:
                                _c.sent();
                                return [4 /*yield*/, clock.settle()];
                            case 2:
                                _c.sent();
                                token = (_b = (_a = typed.at(-1)) === null || _a === void 0 ? void 0 : _a.match(/<!-- report (\S+) -->/)) === null || _b === void 0 ? void 0 : _b[1];
                                files["/repo-".concat(worker, "/.herdr-agents/").concat(worker, "/RESULT.md")] = "<!-- report ".concat(token, " -->\n").concat(text);
                                return [2 /*return*/];
                        }
                    });
                }); };
                return [4 /*yield*/, report('w-done', 'Reviewed: approve.')];
            case 2:
                _b.sent();
                return [4 /*yield*/, report('w-ask', 'DECISION: Ship it today? | Yes | No')
                    // herdr shows this one still working after its report.
                ];
            case 3:
                _b.sent();
                // herdr shows this one still working after its report.
                return [4 /*yield*/, report('w-busy', 'Reviewed: two blockers.')
                    // The first sweep reports all three: w-busy stays working, so its wait is not finished.
                ];
            case 4:
                // herdr shows this one still working after its report.
                _b.sent();
                // The first sweep reports all three: w-busy stays working, so its wait is not finished.
                return [4 /*yield*/, clock.advance(60000)];
            case 5:
                // The first sweep reports all three: w-busy stays working, so its wait is not finished.
                _b.sent();
                return [4 /*yield*/, clock.advance(29 * 60000)];
            case 6:
                _b.sent();
                (0, testing_1.expect)(closed).toEqual([]);
                return [4 /*yield*/, clock.advance(2 * 60000)];
            case 7:
                _b.sent();
                (0, testing_1.expect)(closed).toEqual(['t-w-done']);
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })];
            case 8:
                late = _b.sent();
                (0, testing_1.expect)(JSON.stringify(late)).toMatch(/tab is closed\. Spawn a fresh worker in \/repo-w-done/);
                // Once its question is settled, the worker that asked it goes too.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'Yes', by: 'owner' })];
            case 9:
                // Once its question is settled, the worker that asked it goes too.
                _b.sent();
                return [4 /*yield*/, clock.advance(60000)];
            case 10:
                _b.sent();
                (0, testing_1.expect)(closed).toEqual(['t-w-done', 't-w-ask']);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 11:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
// It runs an hour of refreshes, which a busy CI runner can take most of the default 5 s over.
(0, testing_1.test)('a worker that stops without a report is reported once its screen sits still; background work of its own buys it an hour', { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, screens, box, reports;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, screens = _a.screens;
                box = '────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)';
                // Its messages say "1 shell" and "still running", and every footer shows "← 1 agent".
                screens['p-w-done'] =
                    "\u23FA Ran 1 shell command\n  The east shot is still running.\n".concat(box, "\n  \u23F5\u23F5 auto mode on (shift+tab to cycle) \u00B7 PR #12 \u00B7 \u2190 1 agent");
                screens['p-w-shell'] = "\u23FA Waiting for the dev server.\n".concat(box, "\n  \u23F5\u23F5 auto mode on \u00B7 1 shell \u00B7 \u2190 1 agent");
                screens['p-w-sub'] = "\u23FA Waiting on the review.\n".concat(box, "\n  \u23F5\u23F5 auto mode on\n  \u23FA main\n  \u25EF general-purpose  Review the diff");
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-done', 'w-shell', 'w-sub'])];
            case 2:
                _b.sent();
                reports = function (name) { return submitted.filter(function (t) { return t.includes("<herdr-agent name=\"".concat(name, "\"")); }); };
                return [4 /*yield*/, clock.advance(7 * 60000)];
            case 3:
                _b.sent();
                (0, testing_1.expect)(reports('w-done')[0]).toMatch(/stopped \(done, screen unchanged for 5 min\) without writing RESULT\.md/);
                (0, testing_1.expect)(reports('w-shell')).toEqual([]);
                (0, testing_1.expect)(reports('w-sub')).toEqual([]);
                return [4 /*yield*/, clock.advance(55 * 60000)];
            case 4:
                _b.sent();
                (0, testing_1.expect)(reports('w-shell')[0]).toMatch(/screen unchanged for 60 min/);
                (0, testing_1.expect)(reports('w-sub')).toHaveLength(1);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a session whose $.state lost its jobs gets them back from the store; a report written meanwhile is delivered once', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var job, kept, _a, clock, submitted, typed, files, reports;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                job = function (name) { return ({
                    name: name,
                    profile: 'reviewer',
                    cwd: "/repo-".concat(name),
                    dir: "/repo-".concat(name, "/.herdr-agents/").concat(name),
                    startedAt: 900000,
                    status: 'running',
                    token: "tok-".concat(name),
                }); };
                kept = {
                    'jobs:session-1234': { at: 990000, jobs: { 'w-one': job('w-one'), 'w-two': job('w-two') } },
                    'jobs:old': { at: 0, jobs: {} },
                };
                return [4 /*yield*/, (0, harness_1.start)($, on, {}, kept)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files;
                files['/repo-w-one/.herdr-agents/w-one/RESULT.md'] = '<!-- report tok-w-one -->\nReviewed: approve.';
                return [4 /*yield*/, clock.advance(10000)];
            case 2:
                _b.sent();
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-one"'); }); };
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(reports()[0]).toContain('Reviewed: approve.');
                return [4 /*yield*/, clock.advance(30000)];
            case 3:
                _b.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                // The other worker is still reachable.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-two', text: 'Also check the docs.' })];
            case 4:
                // The other worker is still reachable.
                _b.sent();
                (0, testing_1.expect)(typed.at(-1)).toMatch(/Your coordinator sent an extra message while you work/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-two'])];
            case 5:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
// The argv of a worker's two herdr waits: its turn's end, and its next turn's start.
var FINISH = function (name) { return ['herdr', 'agent', 'wait', name, '--until', 'done', '--until', 'idle', '--until', 'blocked']; };
var RESUME = function (name) { return ['herdr', 'agent', 'wait', name, '--until', 'working', '--until', 'blocked']; };
(0, testing_1.test)('a report is delivered the moment herdr sees the worker finish, and only once', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, calls, typed, files, finish, token, reports;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, calls = _a.calls, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                (0, testing_1.expect)(calls).toContainEqual(FINISH('w-busy'));
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                // No clock advance before the finish: herdr's answer to the wait is what delivers the report.
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                // No clock advance before the finish: herdr's answer to the wait is what delivers the report.
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); }); };
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./);
                return [4 /*yield*/, clock.advance(3 * 60000)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 6:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a report that lands while its worker still works is delivered within one tick, and its turn's end adds nothing", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, closed, files, finish, token, reports;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, closed = _a.closed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                // herdr still shows the worker working: its wait has not ended, and its turn goes on after the report.
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _d.sent();
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); }); };
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./);
                // The report prompts nothing in the worker and closes nothing.
                (0, testing_1.expect)(typed).toHaveLength(1);
                (0, testing_1.expect)(closed).toEqual([]);
                // Its turn ends: the wait it still holds settles on a job already reported, so nothing more goes out.
                return [4 /*yield*/, finish('w-busy')];
            case 4:
                // Its turn ends: the wait it still holds settles on a job already reported, so nothing more goes out.
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(typed).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 6:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a RESULT.md with another prompt's token is not delivered; this prompt's is, within one tick", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, token, reports;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); }); };
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = '<!-- report 0ld0ld00 -->\nReviewed: approve.';
                return [4 /*yield*/, clock.advance(30000)];
            case 3:
                _d.sent();
                (0, testing_1.expect)(reports()).toEqual([]);
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(reports()[0]).toContain('Reviewed: approve.');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a report that lands while a non-Claude worker has messages held waits for its turn to end', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, token, reports;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, { profiles: { x: { kind: 'codex', args: [] } } })];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'x', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                // Held: a codex worker takes no typed input mid-task, so the message goes out once it reports.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })];
            case 3:
                // Held: a codex worker takes no typed input mid-task, so the message goes out once it reports.
                _d.sent();
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000)];
            case 4:
                _d.sent();
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); }); };
                (0, testing_1.expect)(reports()).toEqual([]);
                (0, testing_1.expect)(typed).toHaveLength(1);
                return [4 /*yield*/, finish('w-busy')];
            case 5:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 6:
                _d.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 7:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a worker's tab stays open while herdr shows it working after its early report, and closes once it has sat idle", { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, closed, files, emit, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, { closeIdleMinutes: 1 })];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, closed = _a.closed, files = _a.files, emit = _a.emit;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); })).toHaveLength(1);
                // Ten minutes past its report, herdr still shows it working: the tab stays.
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 4:
                // Ten minutes past its report, herdr still shows it working: the tab stays.
                _d.sent();
                (0, testing_1.expect)(closed).toEqual([]);
                // Its turn ends: the sweep closes the tab once it has sat idle.
                return [4 /*yield*/, emit('w-busy', 'done')];
            case 5:
                // Its turn ends: the sweep closes the tab once it has sat idle.
                _d.sent();
                return [4 /*yield*/, clock.advance(60000)];
            case 6:
                _d.sent();
                (0, testing_1.expect)(closed).toEqual(['t-w-busy']);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a worker's own session delivers its report within one tick, with no herdr call", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, calls, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, calls = _a.calls;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                calls.length = 0;
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 3:
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); })).toHaveLength(1);
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 4:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a worker herdr shows blocked is reported blocked at once', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-stuck'])
                    // herdr's wait answers blocked straight away: the report needs no clock advance, only its batch's wait.
                ];
            case 2:
                _b.sent();
                // herdr's wait answers blocked straight away: the report needs no clock advance, only its batch's wait.
                return [4 /*yield*/, clock.settle()];
            case 3:
                // herdr's wait answers blocked straight away: the report needs no clock advance, only its batch's wait.
                _b.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _b.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/^<herdr-agent name="w-stuck" profile="reviewer" status="blocked">\nThe worker is waiting at an approval/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-stuck'])];
            case 5:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a worker that ends its turn without a report is woken by its next turn, not polled', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, calls, typed, files, emit, finish, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, calls = _a.calls, typed = _a.typed, files = _a.files, emit = _a.emit, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
                    // The turn ends with no report: the wait ends, and the next one waits for the next turn to start.
                ];
            case 2:
                _d.sent();
                // The turn ends with no report: the wait ends, and the next one waits for the next turn to start.
                return [4 /*yield*/, emit('w-busy', 'idle')];
            case 3:
                // The turn ends with no report: the wait ends, and the next one waits for the next turn to start.
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent'); })).toEqual([]);
                (0, testing_1.expect)(calls).toContainEqual(RESUME('w-busy'));
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, finish('w-busy')];
            case 4:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); })).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 6:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a wait child that dies does not hold up its report: the report check delivers it at the next tick', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, kill, token, reports;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, kill = _a.kill;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
                    // herdr ends the wait with an error: the child is gone, and nothing reports for it.
                ];
            case 2:
                _d.sent();
                // herdr ends the wait with an error: the child is gone, and nothing reports for it.
                return [4 /*yield*/, kill('w-busy')];
            case 3:
                // herdr ends the wait with an error: the child is gone, and nothing reports for it.
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); }); };
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('one failed herdr call does not end a job; a tab missing from two sweeps does', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, fail, gone, kill, reports, sent;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, fail = _a.fail, gone = _a.gone, kill = _a.kill;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
                    // The sweep's list and the board's get both fail once: the job stays as it is.
                ];
            case 2:
                _b.sent();
                // The sweep's list and the board's get both fail once: the job stays as it is.
                fail.get = 1;
                fail.list = 1;
                return [4 /*yield*/, clock.advance(60000)];
            case 3:
                _b.sent();
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); }); };
                (0, testing_1.expect)(reports()).toHaveLength(0);
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })];
            case 4:
                sent = _b.sent();
                (0, testing_1.expect)(JSON.stringify(sent)).toMatch(/while it works/);
                (0, testing_1.expect)(typed.at(-1)).toMatch(/while you work/);
                // The tab is gone: the first sweep that misses it counts one, the second reports it.
                gone.add('w-busy');
                return [4 /*yield*/, kill('w-busy')];
            case 5:
                _b.sent();
                return [4 /*yield*/, clock.advance(60000)];
            case 6:
                _b.sent();
                (0, testing_1.expect)(reports()).toHaveLength(0);
                return [4 /*yield*/, clock.advance(60000)];
            case 7:
                _b.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 8:
                _b.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(reports()[0]).toMatch(/status="gone">\nThe worker stopped \(its tab is gone\)/);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a sweep reads herdr once for all workers', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, calls, emit, names, _i, names_1, name_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, calls = _a.calls, emit = _a.emit;
                names = ['w-a', 'w-b', 'w-c'];
                return [4 /*yield*/, (0, harness_1.spawn)($, names)];
            case 2:
                _b.sent();
                _i = 0, names_1 = names;
                _b.label = 3;
            case 3:
                if (!(_i < names_1.length)) return [3 /*break*/, 6];
                name_1 = names_1[_i];
                return [4 /*yield*/, emit(name_1, 'working')];
            case 4:
                _b.sent();
                _b.label = 5;
            case 5:
                _i++;
                return [3 /*break*/, 3];
            case 6:
                calls.length = 0;
                return [4 /*yield*/, clock.advance(5 * 60000)
                    // One list per sweep, however many workers run, and no other herdr call: the 3 s ticks read files only.
                ];
            case 7:
                _b.sent();
                // One list per sweep, however many workers run, and no other herdr call: the 3 s ticks read files only.
                (0, testing_1.expect)(calls.map(function (c) { return c.join(' '); })).toEqual(Array(5).fill('herdr agent list'));
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, names)];
            case 8:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
(0, testing_1.test)('a failed sweep does not mark a reported tab closed', { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, closed, files, fail, token, late;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, typed = _a.typed, closed = _a.closed, files = _a.files, fail = _a.fail;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-done'])];
            case 2:
                _d.sent();
                return [4 /*yield*/, clock.settle()];
            case 3:
                _d.sent();
                token = (_c = (_b = typed.at(-1)) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo-w-done/.herdr-agents/w-done/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(60000)];
            case 4:
                _d.sent();
                return [4 /*yield*/, clock.advance(29 * 60000)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(closed).toEqual([]);
                // The sweep at minute 31 cannot list herdr, so it closes nothing and marks nothing.
                fail.list = 1;
                return [4 /*yield*/, clock.advance(60000)];
            case 6:
                _d.sent();
                (0, testing_1.expect)(closed).toEqual([]);
                return [4 /*yield*/, clock.advance(60000)];
            case 7:
                _d.sent();
                (0, testing_1.expect)(closed).toEqual(['t-w-done']);
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })];
            case 8:
                late = _d.sent();
                (0, testing_1.expect)(JSON.stringify(late)).toMatch(/tab is closed/);
                return [2 /*return*/];
        }
    });
}); });
// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
(0, testing_1.test)('a failed pane read starts no quiet clock', { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, screens, fail, reports;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, screens = _a.screens, fail = _a.fail;
                screens['p-w-quiet'] = '⏺ Done.\n────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)';
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-quiet'])];
            case 2:
                _b.sent();
                reports = function () { return submitted.filter(function (t) { return t.includes('<herdr-agent name="w-quiet"'); }); };
                // Every screen read fails for ten minutes: an error is not a screen that sits still.
                fail.pane = 100;
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 3:
                _b.sent();
                (0, testing_1.expect)(reports()).toEqual([]);
                fail.pane = 0;
                // The first good read, at minute 11, starts the clock; five quiet minutes reports it.
                return [4 /*yield*/, clock.advance(4 * 60000)];
            case 4:
                // The first good read, at minute 11, starts the clock; five quiet minutes reports it.
                _b.sent();
                (0, testing_1.expect)(reports()).toEqual([]);
                return [4 /*yield*/, clock.advance(2 * 60000)];
            case 5:
                _b.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 6:
                _b.sent();
                (0, testing_1.expect)(reports()).toHaveLength(1);
                (0, testing_1.expect)(reports()[0]).toMatch(/stopped \(idle, screen unchanged for 5 min\)/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-quiet'])];
            case 7:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a sweep arms a new wait for a worker whose wait child died while it still works', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, calls, typed, files, kill, finish, armedFinish, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, calls = _a.calls, typed = _a.typed, files = _a.files, kill = _a.kill, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                armedFinish = function () { return calls.filter(function (c) { return c.join(' ') === FINISH('w-busy').join(' '); }).length; };
                (0, testing_1.expect)(armedFinish()).toBe(1);
                return [4 /*yield*/, kill('w-busy')
                    // No report yet, and herdr still shows it working: the sweep arms its wait again.
                ];
            case 3:
                _d.sent();
                // No report yet, and herdr still shows it working: the sweep arms its wait again.
                return [4 /*yield*/, clock.advance(60000)];
            case 4:
                // No report yet, and herdr still shows it working: the sweep arms its wait again.
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent'); })).toEqual([]);
                (0, testing_1.expect)(armedFinish()).toBe(2);
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, finish('w-busy')];
            case 5:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 6:
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); })).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 7:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
(0, testing_1.test)('a reported worker herdr no longer lists is marked closed, with no tab close to make', { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, closed, typed, files, gone, token, late;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, closed = _a.closed, typed = _a.typed, files = _a.files, gone = _a.gone;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-done'])];
            case 2:
                _d.sent();
                return [4 /*yield*/, clock.settle()];
            case 3:
                _d.sent();
                token = (_c = (_b = typed.at(-1)) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo-w-done/.herdr-agents/w-done/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(60000)
                    // herdr drops the tab: the sweep's list leaves it out, and its close is not called.
                ];
            case 4:
                _d.sent();
                // herdr drops the tab: the sweep's list leaves it out, and its close is not called.
                gone.add('w-done');
                return [4 /*yield*/, clock.advance(30 * 60000)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(closed).toEqual([]);
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })];
            case 6:
                late = _d.sent();
                (0, testing_1.expect)(JSON.stringify(late)).toMatch(/tab is closed/);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a prompt that never arrived is not reported over a newer prompt to the same worker', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, stalls;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _b.sent(), clock = _a.clock, submitted = _a.submitted, stalls = _a.stalls;
                stalls['w-lost'] = 3;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })
                    // Stopped and spawned again before the lost report is due: the new prompt is the one running.
                ];
            case 2:
                _b.sent();
                // Stopped and spawned again before the lost report is due: the new prompt is the one running.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-lost' })];
            case 3:
                // Stopped and spawned again before the lost report is due: the new prompt is the one running.
                _b.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it again.' })];
            case 4:
                _b.sent();
                return [4 /*yield*/, clock.advance(10000)];
            case 5:
                _b.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-lost"'); })).toEqual([]);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-lost'])];
            case 6:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
// The mod loads in a worker's own Claude session too, with HERDR_AGENTS_ROLE=worker from its tab.
(0, testing_1.test)("a worker's own session with no running job makes no herdr call, opens no sidebar and writes no board", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, calls, panes, files;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, { view: 'side' }, {}, { HERDR_AGENTS_ROLE: 'worker' })];
            case 1:
                _a = _b.sent(), clock = _a.clock, calls = _a.calls, panes = _a.panes, files = _a.files;
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 2:
                _b.sent();
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                (0, testing_1.expect)(panes).toEqual([]);
                (0, testing_1.expect)(Object.keys(files).filter(function (f) { return f.startsWith('/home/t/.herdr-agents/board/'); })).toEqual([]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a worker's own session sweeps the workers it started while they run, and delivers each report at the next tick", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, calls, kill, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, calls = _a.calls, kill = _a.kill;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
                    // herdr ends the wait with an error: the child is gone, and nothing reports for it.
                ];
            case 2:
                _d.sent();
                // herdr ends the wait with an error: the child is gone, and nothing reports for it.
                return [4 /*yield*/, kill('w-busy')];
            case 3:
                // herdr ends the wait with an error: the child is gone, and nothing reports for it.
                _d.sent();
                calls.length = 0;
                return [4 /*yield*/, clock.advance(60000)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(calls.map(function (c) { return c.join(' '); })).toContain('herdr agent list');
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\nReviewed: approve.");
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)];
            case 5:
                _d.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); })).toHaveLength(1);
                // Its report was its last running job: from then on the session makes no herdr call.
                calls.length = 0;
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 6:
                _d.sent();
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 7:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a worker's own session sweeps its restored running jobs at start-up, not a minute later", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var job, kept, _a, clock, calls;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                job = {
                    name: 'w-busy',
                    profile: 'builder',
                    cwd: '/repo/wt',
                    dir: '/repo/wt/.herdr-agents/w-busy',
                    startedAt: 900000,
                    status: 'running',
                    token: 'tok-busy',
                };
                kept = { 'jobs:session-1234': { at: 990000, jobs: { 'w-busy': job } } };
                return [4 /*yield*/, (0, harness_1.start)($, on, {}, kept, { HERDR_AGENTS_ROLE: 'worker' })
                    // No clock advance: the start-up sweep lists herdr as soon as the session starts.
                ];
            case 1:
                _a = _b.sent(), clock = _a.clock, calls = _a.calls;
                // No clock advance: the start-up sweep lists herdr as soon as the session starts.
                return [4 /*yield*/, clock.settle()];
            case 2:
                // No clock advance: the start-up sweep lists herdr as soon as the session starts.
                _b.sent();
                (0, testing_1.expect)(calls.map(function (c) { return c.join(' '); })).toContain('herdr agent list');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 3:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a worker's own session whose jobs are all reported makes no herdr call, at start-up or after", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var job, kept, _a, clock, calls;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                job = {
                    name: 'w-done',
                    profile: 'builder',
                    cwd: '/repo/wt',
                    dir: '/repo/wt/.herdr-agents/w-done',
                    startedAt: 900000,
                    endedAt: 950000,
                    status: 'reported',
                    closed: true,
                    token: 'tok-done',
                };
                kept = { 'jobs:session-1234': { at: 990000, jobs: { 'w-done': job } } };
                return [4 /*yield*/, (0, harness_1.start)($, on, {}, kept, { HERDR_AGENTS_ROLE: 'worker' })];
            case 1:
                _a = _b.sent(), clock = _a.clock, calls = _a.calls;
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 2:
                _b.sent();
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                return [2 /*return*/];
        }
    });
}); });
var reportedJob = {
    name: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-done',
    startedAt: 900000,
    endedAt: 950000,
    status: 'reported',
    token: 'tok-done',
};
(0, testing_1.test)("a worker's own session closes a nested tab once it has sat idle after its report, then makes no herdr call", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var kept, _a, clock, calls, closed;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                kept = { 'jobs:session-1234': { at: 990000, jobs: { 'w-done': reportedJob } } };
                return [4 /*yield*/, (0, harness_1.start)($, on, { closeIdleMinutes: 1 }, kept, { HERDR_AGENTS_ROLE: 'worker' })];
            case 1:
                _a = _b.sent(), clock = _a.clock, calls = _a.calls, closed = _a.closed;
                return [4 /*yield*/, clock.settle()];
            case 2:
                _b.sent();
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                return [4 /*yield*/, clock.advance(2 * 60000)];
            case 3:
                _b.sent();
                (0, testing_1.expect)(closed).toContain('t-w-done');
                calls.length = 0;
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 4:
                _b.sent();
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('with closeIdleMinutes 0 a worker session with only reported jobs makes no herdr call', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var kept, _a, clock, calls, closed;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                kept = { 'jobs:session-1234': { at: 990000, jobs: { 'w-done': reportedJob } } };
                return [4 /*yield*/, (0, harness_1.start)($, on, { closeIdleMinutes: 0 }, kept, { HERDR_AGENTS_ROLE: 'worker' })];
            case 1:
                _a = _b.sent(), clock = _a.clock, calls = _a.calls, closed = _a.closed;
                return [4 /*yield*/, clock.advance(10 * 60000)];
            case 2:
                _b.sent();
                (0, testing_1.expect)(calls.filter(function (c) { return c[0] === 'herdr'; })).toEqual([]);
                (0, testing_1.expect)(closed).toEqual([]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("spawn marks a worker's tab with HERDR_AGENTS_ROLE=worker, after the profile's env", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, calls, create;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, { profiles: { x: { kind: 'claude', args: [], env: { A: '1' } } } })];
            case 1:
                _a = _c.sent(), clock = _a.clock, calls = _a.calls;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-env', profile: 'x', cwd: '/repo/wt', task: 'x' })];
            case 2:
                _c.sent();
                create = (_b = calls.find(function (c) { return c[1] === 'tab' && c[2] === 'create'; })) !== null && _b !== void 0 ? _b : [];
                (0, testing_1.expect)(create.slice(-4)).toEqual(['--env', 'A=1', '--env', 'HERDR_AGENTS_ROLE=worker']);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-env'])];
            case 3:
                _c.sent();
                return [2 /*return*/];
        }
    });
}); });
// A report's header (report.ts) is what the coordinator reads first: its summary, its question, the
// questions pinned from its DECISION lines, and the file's path.
(0, testing_1.test)('a report with a header reaches the coordinator as its summary, pinned questions and the file path', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, token, body, report;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _e.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _e.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                body = __spreadArray(__spreadArray([
                    '```report',
                    'status: blocked',
                    'pr: 42',
                    'summary: Opened PR #42; the checks pass.',
                    'The reviewer has not run yet.',
                    'ask: Base or develop?',
                    '```'
                ], Array.from({ length: 10 }, function (_, i) { return "Body line ".concat(i + 1, "."); }), true), [
                    'DECISION: [Edit scope] May I edit CI? | Yes (recommended) | No',
                ], false);
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(token, " -->\n").concat(body.join('\n'));
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                _e.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _e.sent();
                report = (_d = submitted.at(-1)) !== null && _d !== void 0 ? _d : '';
                (0, testing_1.expect)(report).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done" result="blocked" pr="42">\n/);
                (0, testing_1.expect)(report).toContain('Opened PR #42; the checks pass.\nThe reviewer has not run yet.\nAsk: Base or develop?\nD1 [Edit scope] May I edit CI? | Yes (recommended) | No\n' +
                    "[Full report, 18 lines: /repo/wt/.herdr-agents/w-busy/RESULT-".concat(token, ".md. Read it only when this summary is not enough.]"));
                (0, testing_1.expect)(report).toContain('[Pinned for the owner as D1. The owner is pinged');
                (0, testing_1.expect)(report).not.toContain('Body line 5.');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 5:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a header report pins its questions inline, in report order, with the title of each that has one', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = [
                    "<!-- report ".concat(token, " -->"),
                    '```report',
                    'status: done',
                    'summary: Two questions for you.',
                    '```',
                    'DECISION: [Port] Which port? | 5173 (recommended) | 8080',
                    'DECISION: Ship it today? | Yes | No',
                ].join('\n');
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/\nTwo questions for you\.\nD1 \[Port\] Which port\? \| 5173 \(recommended\) \| 8080\nD2 Ship it today\? \| Yes \| No\n\[Full report, 6 lines: .+\]\n\n\[Pinned for the owner as D1, D2\./);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a header with nothing after it has no pointer to the file, and an unknown status is no result attribute', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, token;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
                    "<!-- report ".concat(token, " -->\n```report\nstatus: Maybe\nsummary: Nothing to add.\n```");
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                _d.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _d.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nNothing to add\.\n/);
                (0, testing_1.expect)(submitted.at(-1)).not.toContain('Full report');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a header names the PRs a report opens, on the prompt tag; a report without a header is delivered with no pr', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, token, linkToken;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _f.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _f.sent();
                token = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
                    "<!-- report ".concat(token, " -->\n```report\nstatus: done\npr: #12, 13\nsummary: Two PRs.\n```");
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                _f.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _f.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done" result="done" pr="12,13">\n/);
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-link'])];
            case 5:
                _f.sent();
                linkToken = (_e = (_d = typed.at(-1)) === null || _d === void 0 ? void 0 : _d.match(/<!-- report (\S+) -->/)) === null || _e === void 0 ? void 0 : _e[1];
                files['/repo-w-link/.herdr-agents/w-link/RESULT.md'] =
                    "<!-- report ".concat(linkToken, " -->\nReviewed: approve.\nhttps://github.com/acme/app/pull/77");
                return [4 /*yield*/, finish('w-link')];
            case 6:
                _f.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 7:
                _f.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/^<herdr-agent name="w-link" profile="reviewer" status="done">\nReviewed: approve\.\n/);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy', 'w-link'])];
            case 8:
                _f.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a report without a header is delivered as before: a long one as a pointer to its file, a short one inline', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, longToken, shortToken, lines, long, short;
    var _b, _c, _d, _e, _f, _g;
    return __generator(this, function (_h) {
        switch (_h.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _h.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _h.sent();
                longToken = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-short', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })];
            case 3:
                _h.sent();
                shortToken = (_e = (_d = typed[1]) === null || _d === void 0 ? void 0 : _d.match(/<!-- report (\S+) -->/)) === null || _e === void 0 ? void 0 : _e[1];
                lines = Array.from({ length: 9 }, function (_, i) { return "Line ".concat(i + 2, "."); });
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(longToken, " -->\nReviewed the change.\n").concat(lines.join('\n'));
                // Each report goes out in a batch of its own, so the batch's first element is the one a test reads:
                // the short one's file is written once the long one's batch has gone out.
                return [4 /*yield*/, finish('w-busy')];
            case 4:
                // Each report goes out in a batch of its own, so the batch's first element is the one a test reads:
                // the short one's file is written once the long one's batch has gone out.
                _h.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 5:
                _h.sent();
                files['/repo/wt2/.herdr-agents/w-short/RESULT.md'] = "<!-- report ".concat(shortToken, " -->\nReviewed the small change.\nAll green.");
                return [4 /*yield*/, finish('w-short')];
            case 6:
                _h.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 7:
                _h.sent();
                long = (_f = submitted.find(function (t) { return t.includes('<herdr-agent name="w-busy"'); })) !== null && _f !== void 0 ? _f : '';
                (0, testing_1.expect)(long).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed the change\.\n\[Full report, 10 lines: \/repo\/wt\/\.herdr-agents\/w-busy\/RESULT-\w+\.md\. Read it before acting on it\.\]/);
                (0, testing_1.expect)(long).not.toContain('Line 5.');
                short = (_g = submitted.find(function (t) { return t.includes('<herdr-agent name="w-short"'); })) !== null && _g !== void 0 ? _g : '';
                (0, testing_1.expect)(short).toMatch(/^<herdr-agent name="w-short" profile="builder" status="done">\nReviewed the small change\.\nAll green\.\n/);
                (0, testing_1.expect)(short).not.toContain('Full report');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy', 'w-short'])];
            case 8:
                _h.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('the full report rule goes in the first prompt only; follow-ups and wake-ups get a one-line reminder', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, typed, files, finish, firstToken, secondToken;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _f.sent(), clock = _a.clock, submitted = _a.submitted, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _f.sent();
                firstToken = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                (0, testing_1.expect)(typed[0]).toContain('Right below that line, put this header');
                (0, testing_1.expect)(files['/repo/wt/.herdr-agents/w-busy/REPORTING.md']).toContain('<!-- report TOKEN -->');
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(firstToken, " -->\nReviewed: approve.");
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                _f.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 4:
                _f.sent();
                (0, testing_1.expect)(submitted.filter(function (t) { return t.includes('<herdr-agent name="w-busy"'); })).toHaveLength(1);
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'One more thing.' })];
            case 5:
                _f.sent();
                secondToken = (_e = (_d = typed.at(-1)) === null || _d === void 0 ? void 0 : _d.match(/<!-- report (\S+) -->/)) === null || _e === void 0 ? void 0 : _e[1];
                (0, testing_1.expect)(secondToken).not.toBe(firstToken);
                (0, testing_1.expect)(typed.at(-1)).toContain("<!-- report ".concat(secondToken, " -->"));
                (0, testing_1.expect)(typed.at(-1)).toContain('report as before');
                (0, testing_1.expect)(typed.at(-1)).not.toContain('Right below that line');
                // A WAIT.json check that times out wakes the worker with the reminder, not the full rule.
                files['/repo/wt/.herdr-agents/w-busy/WAIT.json'] = '{"for":"ci","check":"false","every":1,"max":5}';
                return [4 /*yield*/, clock.advance(8 * 60000)];
            case 6:
                _f.sent();
                (0, testing_1.expect)(typed.at(-1)).toContain('Your wait is over');
                (0, testing_1.expect)(typed.at(-1)).toContain('report as before');
                (0, testing_1.expect)(typed.at(-1)).not.toContain('Right below that line');
                (0, testing_1.expect)(typed.filter(function (t) { return t.includes('Right below that line'); })).toHaveLength(1);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 7:
                _f.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a worker spawned again with the same name in the same folder gets the full rule in its first prompt', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, files, finish, firstToken, again;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _e.sent(), clock = _a.clock, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _e.sent();
                firstToken = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(firstToken, " -->\nDone.");
                return [4 /*yield*/, finish('w-busy')
                    // The job folder outlives the job: the same name spawned again finds the old REPORTING.md there.
                ];
            case 3:
                _e.sent();
                // The job folder outlives the job: the same name spawned again finds the old REPORTING.md there.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })];
            case 4:
                // The job folder outlives the job: the same name spawned again finds the old REPORTING.md there.
                _e.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it again.' })];
            case 5:
                _e.sent();
                again = (_d = typed.at(-1)) !== null && _d !== void 0 ? _d : '';
                (0, testing_1.expect)(again).toContain('Your task is in /repo/wt/.herdr-agents/w-busy/TASK.md');
                (0, testing_1.expect)(again).toContain('Right below that line, put this header');
                (0, testing_1.expect)(again).not.toContain('report as before');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 6:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('the report rule says to write RESULT.md in one write, as the last step, in the full rule and the reminder', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, files, finish, firstToken;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _d.sent(), clock = _a.clock, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _d.sent();
                (0, testing_1.expect)(typed[0]).toContain('write your final report to /repo/wt/.herdr-agents/w-busy/RESULT.md in one write, as your last step');
                (0, testing_1.expect)(files['/repo/wt/.herdr-agents/w-busy/REPORTING.md']).toContain('in one write, as your last step');
                firstToken = (_c = (_b = typed[0]) === null || _b === void 0 ? void 0 : _b.match(/<!-- report (\S+) -->/)) === null || _c === void 0 ? void 0 : _c[1];
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = "<!-- report ".concat(firstToken, " -->\nDone.");
                return [4 /*yield*/, finish('w-busy')];
            case 3:
                _d.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'One more thing.' })];
            case 4:
                _d.sent();
                (0, testing_1.expect)(typed.at(-1)).toContain('in one write, as your last step');
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 5:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
// The jobs map does not grow for good: reported jobs leave it a week after they ended.
(0, testing_1.test)('reported jobs older than 7 days are dropped from the state and the store; newer and running ones stay', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var day, job, jobs, _a, clock, store, kept;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                day = 24 * 60 * 60000;
                job = function (name, over) { return (__assign({ name: name, profile: 'builder', cwd: '/repo/wt', dir: "/repo/wt/.herdr-agents/".concat(name), startedAt: 900000, token: "tok-".concat(name) }, over)); };
                jobs = {
                    'w-old': job('w-old', { status: 'reported', endedAt: 1000000 - 8 * day }),
                    'w-new': job('w-new', { status: 'reported', endedAt: 1000000 - 6 * day }),
                    'w-run': job('w-run', { status: 'running', startedAt: 1000000 - 30 * day }),
                };
                return [4 /*yield*/, (0, harness_1.start)($, on, {}, { 'jobs:session-1234': { at: 990000, jobs: jobs } })];
            case 1:
                _a = _b.sent(), clock = _a.clock, store = _a.store;
                return [4 /*yield*/, clock.settle()];
            case 2:
                _b.sent();
                kept = store.get('jobs:session-1234');
                (0, testing_1.expect)(Object.keys(kept.jobs).sort()).toEqual(['w-new', 'w-run']);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-run'])];
            case 3:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('prune runs git rev-parse once per folder', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var job, jobs, _a, clock, shell, files;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                job = function (name) { return ({
                    name: name,
                    profile: 'builder',
                    cwd: '/repo/wt',
                    dir: "/repo/wt/.herdr-agents/".concat(name),
                    startedAt: 900000,
                    endedAt: 950000,
                    status: 'reported',
                    token: "tok-".concat(name),
                }); };
                jobs = { 'w-a': job('w-a'), 'w-b': job('w-b'), 'w-c': job('w-c') };
                return [4 /*yield*/, (0, harness_1.start)($, on, {}, { 'jobs:session-1234': { at: 990000, jobs: jobs } })];
            case 1:
                _a = _b.sent(), clock = _a.clock, shell = _a.shell, files = _a.files;
                files['/repo/wt/x'] = '';
                return [4 /*yield*/, clock.settle()];
            case 2:
                _b.sent();
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-prune')];
            case 3:
                _b.sent();
                (0, testing_1.expect)(shell.filter(function (c) { return c.includes('rev-parse') && c.includes('--git-common-dir'); })).toHaveLength(1);
                return [2 /*return*/];
        }
    });
}); });
