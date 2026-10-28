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
Object.defineProperty(exports, "__esModule", { value: true });
var testing_1 = require("claude-code/testing");
var defaults_1 = require("../hooks/defaults");
var tasks_1 = require("../hooks/tasks");
var harness_1 = require("./harness");
// The sidebar (/hrd-side): work by issue or PR, what needs the person, and the answer box.
var PANE = {
    plugin: 'herdr-agents',
    component: 'Pane',
    requestId: 'hrd-side',
    props: { title: 'herdr', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
};
(0, testing_1.test)('workers on one issue share a row, and an answer stays in its slot until clear done', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, _b, ui, _c, _d, _e, _f, _g, _h, _j, _k, _l, band, _m, _o, _p;
    var _q, _r, _s, _t, _u, _v, _w;
    return __generator(this, function (_x) {
        switch (_x.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _x.sent(), clock = _a.clock, submitted = _a.submitted;
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__spawn',
                        worker: 'p-640',
                        profile: 'planner',
                        cwd: '/repo',
                        task: '# Plan acme/app-client issue #640 (Sort bags)\n\nRead the issue.',
                    })];
            case 2:
                _x.sent();
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__spawn',
                        worker: 'w-busy',
                        profile: 'builder',
                        cwd: '/repo/wt',
                        task: 'Build #640: sort by type',
                    })];
            case 3:
                _x.sent();
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__ask_owner',
                        question: 'Sort bags by type or by weight?',
                        title: 'Bag sort order',
                        options: ['By weight', 'By type'],
                        recommended: 1,
                        from: 'w-busy',
                    })];
            case 4:
                _x.sent();
                return [4 /*yield*/, clock.advance(1000)];
            case 5:
                _x.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })];
            case 6:
                _x.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-side')];
            case 7:
                _b.apply(void 0, [(_x.sent()).text]).toMatch(/Sidebar open/);
                return [4 /*yield*/, clock.advance(3000)];
            case 8:
                _x.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, PANE), { surface: 'terminal' }))
                    // plan and build run, CI has not started, the question is the person's.
                ];
            case 9:
                ui = _x.sent();
                // plan and build run, CI has not started, the question is the person's.
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#640' })];
            case 10:
                // plan and build run, CI has not started, the question is the person's.
                _c.apply(void 0, [(_q = (_x.sent())) === null || _q === void 0 ? void 0 : _q.text]).toMatch(/#640 +Sort bags +◐ +◐ +· +· +\? +w-busy now/);
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-D1' })];
            case 11:
                _d.apply(void 0, [(_r = (_x.sent())) === null || _r === void 0 ? void 0 : _r.text]).toMatch(/▸ \? D1 +Bag sort order +#640/);
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-T1' })];
            case 12:
                _e.apply(void 0, [(_s = (_x.sent())) === null || _s === void 0 ? void 0 : _s.text]).toMatch(/☐ T1 +Merge server #77 +#77/);
                // The recommended answer comes first; answering keeps the box on D1 and its row in place.
                return [4 /*yield*/, ui.press({ key: 'opt-1-0' })];
            case 13:
                // The recommended answer comes first; answering keeps the box on D1 and its row in place.
                _x.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 14:
                _x.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/<herdr-decision id="D1" from="w-busy">[\s\S]*The owner chose: By type/);
                _f = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-D1' })];
            case 15:
                _f.apply(void 0, [(_t = (_x.sent())) === null || _t === void 0 ? void 0 : _t.text]).toMatch(/✓ D1 +Bag sort order/);
                _g = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: '✓ By type' })];
            case 16:
                _g.apply(void 0, [_x.sent()]).toBeDefined();
                _h = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'next' })];
            case 17:
                _h.apply(void 0, [(_u = (_x.sent())) === null || _u === void 0 ? void 0 : _u.text]).toBe('next T1 ▸');
                _j = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#640' })];
            case 18:
                _j.apply(void 0, [(_v = (_x.sent())) === null || _v === void 0 ? void 0 : _v.text]).toMatch(/◐ +◐ +· +· +✓ +w-busy/);
                return [4 /*yield*/, ui.press({ key: 'clear-items' })];
            case 19:
                _x.sent();
                _k = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-D1' })];
            case 20:
                _k.apply(void 0, [_x.sent()]).toBeUndefined();
                _l = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-T1' })];
            case 21:
                _l.apply(void 0, [(_w = (_x.sent())) === null || _w === void 0 ? void 0 : _w.text]).toMatch(/☐ T1/);
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 22:
                band = _x.sent();
                _m = testing_1.expect;
                return [4 /*yield*/, band.find({ type: 'Text', text: /engine band/ })];
            case 23:
                _m.apply(void 0, [_x.sent()]).toBeDefined();
                _o = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-side')];
            case 24:
                _o.apply(void 0, [(_x.sent()).text]).toBe('Sidebar closed.');
                return [4 /*yield*/, band.redraw()];
            case 25:
                _x.sent();
                _p = testing_1.expect;
                return [4 /*yield*/, band.find({ type: 'Text', text: /^☐ Merge server .*#77 +T1/ })];
            case 26:
                _p.apply(void 0, [_x.sent()]).toBeDefined();
                return [4 /*yield*/, band.unmount()];
            case 27:
                _x.sent();
                return [4 /*yield*/, ui.unmount()];
            case 28:
                _x.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['p-640', 'w-busy'])];
            case 29:
                _x.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("a reviewer joins the row of the PR its builder linked, with the PR's checks", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, files, prs, finish, token, ui, row12, _b, _c, _d, _e, _f, _g, _h;
    var _j, _k, _l, _m;
    return __generator(this, function (_o) {
        switch (_o.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _o.sent(), clock = _a.clock, typed = _a.typed, files = _a.files, prs = _a.prs, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__spawn',
                        worker: 'w-done',
                        profile: 'builder',
                        cwd: '/repo/wt',
                        task: '# Build #12: hotbar keys',
                    })];
            case 2:
                _o.sent();
                return [4 /*yield*/, clock.settle()];
            case 3:
                _o.sent();
                token = (_k = (_j = typed[0]) === null || _j === void 0 ? void 0 : _j.match(/<!-- report (\S+) -->/)) === null || _k === void 0 ? void 0 : _k[1];
                files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
                    "<!-- report ".concat(token, " -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.");
                return [4 /*yield*/, finish('w-done')];
            case 4:
                _o.sent();
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__spawn',
                        worker: 'r-15',
                        profile: 'reviewer',
                        cwd: '/repo',
                        task: 'Review acme/app-client PR #15 (hotbar keys)',
                    })];
            case 5:
                _o.sent();
                prs['acme/app-client#15'] = { state: 'OPEN', statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] };
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-side')];
            case 6:
                _o.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 7:
                _o.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, PANE), { surface: 'terminal' }))];
            case 8:
                ui = _o.sent();
                row12 = function () { return __awaiter(void 0, void 0, void 0, function () { var _a, _b; return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0: return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#12' })];
                        case 1: return [2 /*return*/, (_b = (_a = (_c.sent())) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : ''
                            // The PR poll that opening the sidebar starts answers in the background.
                        ];
                    }
                }); }); };
                // The PR poll that opening the sidebar starts answers in the background.
                return [4 /*yield*/, (0, harness_1.until)(clock, function () { return __awaiter(void 0, void 0, void 0, function () { var _a, _b; return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0:
                                _b = (_a = /◐ +◐/).test;
                                return [4 /*yield*/, row12()];
                            case 1: return [2 /*return*/, _b.apply(_a, [_c.sent()])];
                        }
                    }); }); })
                    // No planner, the build reported, the review runs and so do the PR's checks.
                ];
            case 9:
                // The PR poll that opening the sidebar starts answers in the background.
                _o.sent();
                // No planner, the build reported, the review runs and so do the PR's checks.
                _b = testing_1.expect;
                return [4 /*yield*/, row12()];
            case 10:
                // No planner, the build reported, the review runs and so do the PR's checks.
                _b.apply(void 0, [_o.sent()]).toMatch(/#12 +hotbar keys +· +✓ +◐ +◐ +· +r-15 now/);
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#15' })];
            case 11:
                _c.apply(void 0, [_o.sent()]).toBeUndefined();
                // The # opens the PR, and nothing waits for the person, so the box stays empty.
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'gh-acme/app-client#12' })];
            case 12:
                // The # opens the PR, and nothing waits for the person, so the box stays empty.
                _d.apply(void 0, [(_l = (_o.sent())) === null || _l === void 0 ? void 0 : _l.text]).toBe('#12');
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /Pick a row/ })];
            case 13:
                _e.apply(void 0, [_o.sent()]).toBeUndefined();
                // Once the review is in and the PR merged, the row is done until clear done removes it.
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['r-15'])];
            case 14:
                // Once the review is in and the PR merged, the row is done until clear done removes it.
                _o.sent();
                prs['acme/app-client#15'] = {
                    state: 'MERGED',
                    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
                };
                return [4 /*yield*/, clock.advance(2 * 60000)
                    // So does the poll at the 2-minute tick.
                ];
            case 15:
                _o.sent();
                // So does the poll at the 2-minute tick.
                return [4 /*yield*/, (0, harness_1.until)(clock, function () { return __awaiter(void 0, void 0, void 0, function () { var _a, _b; return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0:
                                _b = (_a = /merged/).test;
                                return [4 /*yield*/, row12()];
                            case 1: return [2 /*return*/, _b.apply(_a, [_c.sent()])];
                        }
                    }); }); })];
            case 16:
                // So does the poll at the 2-minute tick.
                _o.sent();
                _f = testing_1.expect;
                return [4 /*yield*/, row12()];
            case 17:
                _f.apply(void 0, [_o.sent()]).toMatch(/· +✓ +✓ +✓ +· +merged/);
                return [4 /*yield*/, ui.press({ key: 'clear-tasks' })];
            case 18:
                _o.sent();
                _g = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#12' })];
            case 19:
                _g.apply(void 0, [_o.sent()]).toBeUndefined();
                // A new worker on it brings the row back.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'f-12', profile: 'builder', cwd: '/repo/wt2', task: 'Fix round for #12' })];
            case 20:
                // A new worker on it brings the row back.
                _o.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 21:
                _o.sent();
                _h = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#12' })];
            case 22:
                _h.apply(void 0, [(_m = (_o.sent())) === null || _m === void 0 ? void 0 : _m.text]).toMatch(/#12 +hotbar keys +· +◐/);
                return [4 /*yield*/, ui.unmount()];
            case 23:
                _o.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['f-12'])];
            case 24:
                _o.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('one number in two repos is two rows, and a row that joins another keeps its slot', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, files, prs, spawn, ui, _b, _c, _d, token, _e, _f, _g, _h;
    var _j, _k, _l, _m, _o, _p, _q;
    return __generator(this, function (_r) {
        switch (_r.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _r.sent(), clock = _a.clock, typed = _a.typed, files = _a.files, prs = _a.prs;
                spawn = function (worker, profile, cwd, task) {
                    return $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: worker, profile: profile, cwd: cwd, task: task });
                };
                return [4 /*yield*/, spawn('c-640', 'builder', '/repo', 'Build #640: sort bags')];
            case 2:
                _r.sent();
                return [4 /*yield*/, spawn('s-640', 'builder', '/srv', 'Build #640: bag weights')];
            case 3:
                _r.sent();
                return [4 /*yield*/, spawn('w-12', 'builder', '/repo/wt', 'Build #12: hotbar keys')];
            case 4:
                _r.sent();
                return [4 /*yield*/, spawn('r-15', 'reviewer', '/repo', 'Review PR #15 (hotbar keys)')];
            case 5:
                _r.sent();
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-side')];
            case 6:
                _r.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 7:
                _r.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, PANE), { surface: 'terminal' }))];
            case 8:
                ui = _r.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#640' })];
            case 9:
                _b.apply(void 0, [(_j = (_r.sent())) === null || _j === void 0 ? void 0 : _j.text]).toMatch(/#640 +sort bags/);
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-server#640' })];
            case 10:
                _c.apply(void 0, [(_k = (_r.sent())) === null || _k === void 0 ? void 0 : _k.text]).toMatch(/#640 +bag weights/);
                // The review runs before the builder's report says which PR it opened: a row of its own.
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#15' })];
            case 11:
                // The review runs before the builder's report says which PR it opened: a row of its own.
                _d.apply(void 0, [(_l = (_r.sent())) === null || _l === void 0 ? void 0 : _l.text]).toMatch(/#15 +hotbar keys +· +· +◐/);
                token = (_o = (_m = typed.find(function (t) { return t.includes('w-12'); })) === null || _m === void 0 ? void 0 : _m.match(/<!-- report (\S+) -->/)) === null || _o === void 0 ? void 0 : _o[1];
                files['/repo/wt/.herdr-agents/w-12/RESULT.md'] = "<!-- report ".concat(token, " -->\nOpened https://github.com/acme/app-client/pull/15.");
                prs['acme/app-client#15'] = {
                    state: 'OPEN',
                    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
                };
                return [4 /*yield*/, clock.advance(10000)];
            case 12:
                _r.sent();
                return [4 /*yield*/, clock.advance(2 * 60000)];
            case 13:
                _r.sent();
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#12' })];
            case 14:
                _e.apply(void 0, [(_p = (_r.sent())) === null || _p === void 0 ? void 0 : _p.text]).toMatch(/#12 +hotbar keys +· +✓ +◐ +■ +· +r-15/);
                _f = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#15' })];
            case 15:
                _f.apply(void 0, [(_q = (_r.sent())) === null || _q === void 0 ? void 0 : _q.text]).toMatch(/#15 +joined #12/);
                return [4 /*yield*/, ui.press({ key: 'clear-tasks' })];
            case 16:
                _r.sent();
                _g = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#15' })];
            case 17:
                _g.apply(void 0, [_r.sent()]).toBeUndefined();
                _h = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#12' })];
            case 18:
                _h.apply(void 0, [_r.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 19:
                _r.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['c-640', 's-640', 'r-15'])];
            case 20:
                _r.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('the box shows every answer at the same height, and a closed item keeps its slot', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, ui, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    var _r, _s, _t, _u, _v;
    return __generator(this, function (_w) {
        switch (_w.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _w.sent(), clock = _a.clock, submitted = _a.submitted;
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__ask_owner',
                        question: 'The bag window needs one layout for the first release. The old client used a fixed grid; testers asked for sorting by weight, and the art team drew tabs per item type. Which one ships first?',
                        title: 'Bag layout',
                        options: ['A fixed grid like the old client', 'Sorted by weight', 'Tabs per item type', 'Both, behind a setting'],
                        recommended: 2,
                    })];
            case 2:
                _w.sent();
                return [4 /*yield*/, clock.advance(1000)];
            case 3:
                _w.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship on Friday?', title: 'Ship day', options: ['Yes', 'No'] })];
            case 4:
                _w.sent();
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-side')];
            case 5:
                _w.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 6:
                _w.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, PANE), { surface: 'terminal' }))
                    // Four answers, the recommended first, take two lines, so the question keeps two.
                ];
            case 7:
                ui = _w.sent();
                // Four answers, the recommended first, take two lines, so the question keeps two.
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'opt-1-0' })];
            case 8:
                // Four answers, the recommended first, take two lines, so the question keeps two.
                _b.apply(void 0, [(_r = (_w.sent())) === null || _r === void 0 ? void 0 : _r.text]).toBe(' Tabs per item type ');
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'opt-1-1' })];
            case 9:
                _c.apply(void 0, [(_s = (_w.sent())) === null || _s === void 0 ? void 0 : _s.text]).toBe('A fixed grid like the old …');
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'opt-1-3' })];
            case 10:
                _d.apply(void 0, [_w.sent()]).toBeDefined();
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'ol1' })];
            case 11:
                _e.apply(void 0, [_w.sent()]).toBeDefined();
                _f = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^The bag window needs one layout/ })];
            case 12:
                _f.apply(void 0, [_w.sent()]).toBeDefined();
                _g = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^(old )?client used a fixed grid.*…$/ })];
            case 13:
                _g.apply(void 0, [_w.sent()]).toBeDefined();
                _h = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /ships first/ })];
            case 14:
                _h.apply(void 0, [_w.sent()]).toBeUndefined();
                _j = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: 'tab moves · enter presses' })];
            case 15:
                _j.apply(void 0, [_w.sent()]).toBeDefined();
                // The coordinator settles D1: it stays in its slot, struck through, with the answer, and
                // a new to-do takes the next free slot.
                return [4 /*yield*/, ui.press({ key: 'item-D1' })];
            case 16:
                // The coordinator settles D1: it stays in its slot, struck through, with the answer, and
                // a new to-do takes the next free slot.
                _w.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'Tabs', by: 'coordinator' })];
            case 17:
                _w.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test the bags at http://localhost:5173' })];
            case 18:
                _w.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 19:
                _w.sent();
                _k = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-D1' })];
            case 20:
                _k.apply(void 0, [(_t = (_w.sent())) === null || _t === void 0 ? void 0 : _t.text]).toMatch(/✓ D1 +Bag layout/);
                _l = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: '✓ Tabs (coordinator)' })];
            case 21:
                _l.apply(void 0, [_w.sent()]).toBeDefined();
                _m = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'item-T1' })];
            case 22:
                _m.apply(void 0, [(_u = (_w.sent())) === null || _u === void 0 ? void 0 : _u.text]).toMatch(/☐ T1 +Test the bags/);
                // A to-do's box links what its text names; Done sends it.
                return [4 /*yield*/, ui.press({ key: 'item-T1' })];
            case 23:
                // A to-do's box links what its text names; Done sends it.
                _w.sent();
                _o = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'url-1' })];
            case 24:
                _o.apply(void 0, [(_v = (_w.sent())) === null || _v === void 0 ? void 0 : _v.text]).toBe('open');
                return [4 /*yield*/, ui.press({ key: 'tick-1' })];
            case 25:
                _w.sent();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 26:
                _w.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/herdr-owner-done/);
                _p = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: '✓ done' })];
            case 27:
                _p.apply(void 0, [_w.sent()]).toBeDefined();
                _q = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: 'T1 done · sent' })];
            case 28:
                _q.apply(void 0, [_w.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 29:
                _w.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('workers join through shared numbers, and only a role name gives a number', function () { return __awaiter(void 0, void 0, void 0, function () {
    var job, tasks;
    return __generator(this, function (_a) {
        job = function (name, startedAt, refs) { return ({
            name: name,
            profile: 'builder',
            cwd: '/x',
            dir: '/x',
            startedAt: startedAt,
            status: 'running',
            refs: refs,
        }); };
        (0, testing_1.expect)((0, tasks_1.briefRefs)('Fix the login page', 'w-20251023').refs).toBeUndefined();
        (0, testing_1.expect)((0, tasks_1.briefRefs)('Fix the login page', 'b513-c1').refs).toEqual([513]);
        (0, testing_1.expect)((0, tasks_1.briefRefs)('Review acme/app PR #9', 'r-1').prs).toEqual([9]);
        tasks = (0, tasks_1.groupTasks)({
            jobs: [job('a', 1, [1]), job('b', 2, [1, 2]), job('c', 3, [2]), job('d', 4, [3])],
            rows: [],
            items: [],
            prs: {},
            now: 10,
            repoOf: function () { return 'acme/app'; },
        });
        (0, testing_1.expect)(tasks.map(function (t) { return [t.key, t.jobs.map(function (j) { return j.name; }).join()]; })).toEqual([
            ['acme/app#1', 'a,b,c'],
            ['acme/app#3', 'd'],
        ]);
        return [2 /*return*/];
    });
}); });
(0, testing_1.test)("a report's PR goes to its worker's row on the sidebar: the header's, else the link in a report without one", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, typed, files, finish, tokens, _b, ui, _c, _d;
    var _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _g.sent(), clock = _a.clock, typed = _a.typed, files = _a.files, finish = _a.finish;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })];
            case 2:
                _g.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-link', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })];
            case 3:
                _g.sent();
                tokens = [typed[0], typed[1]].map(function (t) { var _a; return (_a = t === null || t === void 0 ? void 0 : t.match(/<!-- report (\S+) -->/)) === null || _a === void 0 ? void 0 : _a[1]; });
                files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
                    "<!-- report ".concat(tokens[0], " -->\n```report\nstatus: done\npr: 12\nsummary: Opened PR #12.\n```");
                files['/repo/wt2/.herdr-agents/w-link/RESULT.md'] = "<!-- report ".concat(tokens[1], " -->\nOpened https://github.com/acme/app-client/pull/77.");
                return [4 /*yield*/, finish('w-busy')];
            case 4:
                _g.sent();
                return [4 /*yield*/, finish('w-link')];
            case 5:
                _g.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-side')];
            case 6:
                _b.apply(void 0, [(_g.sent()).text]).toMatch(/Sidebar open/);
                return [4 /*yield*/, clock.advance(3000)];
            case 7:
                _g.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, PANE), { surface: 'terminal' }))
                    // Each worker's row is keyed by the PR its report names: the header's, or the link in a report without one.
                ];
            case 8:
                ui = _g.sent();
                // Each worker's row is keyed by the PR its report names: the header's, or the link in a report without one.
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#12' })];
            case 9:
                // Each worker's row is keyed by the PR its report names: the header's, or the link in a report without one.
                _c.apply(void 0, [(_e = (_g.sent())) === null || _e === void 0 ? void 0 : _e.text]).toMatch(/^#12 /);
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'task-acme/app-client#77' })];
            case 10:
                _d.apply(void 0, [(_f = (_g.sent())) === null || _f === void 0 ? void 0 : _f.text]).toMatch(/^#77 /);
                return [4 /*yield*/, ui.unmount()];
            case 11:
                _g.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy', 'w-link'])];
            case 12:
                _g.sent();
                return [2 /*return*/];
        }
    });
}); });
