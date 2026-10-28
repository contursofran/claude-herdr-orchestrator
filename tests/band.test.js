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
var harness_1 = require("./harness");
// The band above the prompt: what pin_for_owner pins at the top, the workers, and #123 links.
// Run with `claude plugin test .`.
(0, testing_1.test)('a pinned to-do shows at the top, and Done unpins it and tells the coordinator', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, ui, line, _b, _c, _d, _e, before;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _f.sent(), clock = _a.clock, submitted = _a.submitted;
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565', from: 'app-client#541' })];
            case 2:
                _f.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Staging disk at 98 GB free', kind: 'know' })
                    // The same text again keeps its id.
                ];
            case 3:
                _f.sent();
                // The same text again keeps its id.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565' })];
            case 4:
                // The same text again keeps its id.
                _f.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))
                    // The #numbers link once the start-up refresh, which runs in the background, has learned /repo's
                    // GitHub remote. A Link's found text is its href, then what it draws: the line as drawn leaves the hrefs out.
                ];
            case 5:
                ui = _f.sent();
                line = function (text) { return __awaiter(void 0, void 0, void 0, function () { var _a; return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0: return [4 /*yield*/, ui.find({ type: 'Text', text: text })];
                        case 1: return [2 /*return*/, (_a = (_b.sent())) === null || _a === void 0 ? void 0 : _a.text.replace(/https:\/\/github\.com\/[^#]+?\/issues\/\d+/g, '')];
                    }
                }); }); };
                _b = testing_1.expect;
                return [4 /*yield*/, line(/Merge client/)];
            case 6:
                _b.apply(void 0, [_f.sent()]).toMatch(/☐ Merge client #565\s+T1 · app-client#541/);
                _c = testing_1.expect;
                return [4 /*yield*/, line(/98 GB/)];
            case 7:
                _c.apply(void 0, [_f.sent()]).toMatch(/ℹ Staging disk at 98 GB free\s+T2 · coordinator/);
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /T3/ })];
            case 8:
                _d.apply(void 0, [_f.sent()]).toBeUndefined();
                return [4 /*yield*/, ui.press({ key: 'tick-t1' })];
            case 9:
                _f.sent();
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /Merge client/ })];
            case 10:
                _e.apply(void 0, [_f.sent()]).toBeUndefined();
                return [4 /*yield*/, clock.advance(defaults_1.BATCH_MS)];
            case 11:
                _f.sent();
                (0, testing_1.expect)(submitted.at(-1)).toMatch(/<herdr-owner-done id="T1" from="app-client#541">\nThe owner ticked off: Merge client #565/);
                before = submitted.length;
                return [4 /*yield*/, ui.press({ key: 'tick-t2' })];
            case 12:
                _f.sent();
                (0, testing_1.expect)(submitted.length).toBe(before);
                return [4 /*yield*/, ui.unmount()];
            case 13:
                _f.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('unpin_for_owner removes items by id and names the ones it did not find', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var out, ui, _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _b.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #526 at http://localhost:5173' })];
            case 2:
                _b.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__unpin_for_owner', ids: ['T1', 'T9'] })];
            case 3:
                out = _b.sent();
                (0, testing_1.expect)(JSON.stringify(out)).toMatch(/Unpinned 1\. Not pinned \(already done or wrong id\): T9\. 0 item/);
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 4:
                ui = _b.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /engine band/ })];
            case 5:
                _a.apply(void 0, [_b.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 6:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('workers show one per row, two per line, the one that needs the person first', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var clock, names, ui, _a, _i, names_1, name_1, _b, _c, _d, _e, _f;
    var _g, _h, _j, _k, _l;
    return __generator(this, function (_m) {
        switch (_m.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                clock = (_m.sent()).clock;
                names = ['w-busy', 'w-done', 'w-stuck'];
                return [4 /*yield*/, (0, harness_1.spawn)($, names)];
            case 2:
                _m.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 3:
                _m.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))
                    // A blocked worker is reported at once, so it no longer counts as running; the header names the roles.
                ];
            case 4:
                ui = _m.sent();
                // A blocked worker is reported at once, so it no longer counts as running; the header names the roles.
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /workers/ })];
            case 5:
                // A blocked worker is reported at once, so it no longer counts as running; the header names the roles.
                _a.apply(void 0, [(_g = (_m.sent())) === null || _g === void 0 ? void 0 : _g.text]).toBe('2/4 workers: 2 reviewers');
                _i = 0, names_1 = names;
                _m.label = 6;
            case 6:
                if (!(_i < names_1.length)) return [3 /*break*/, 9];
                name_1 = names_1[_i];
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, name_1)];
            case 7:
                _b.apply(void 0, [_m.sent()]).toBeDefined();
                _m.label = 8;
            case 8:
                _i++;
                return [3 /*break*/, 6];
            case 9:
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /Reported/ })];
            case 10:
                _c.apply(void 0, [(_h = (_m.sent())) === null || _h === void 0 ? void 0 : _h.text]).toMatch(/^● w-stuck +reviewer +\S+ +Reported$/);
                // Two lines: the working one first, then the one that is done, on the left; the reported one on the right.
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'col0' })];
            case 11:
                // Two lines: the working one first, then the one that is done, on the left; the reported one on the right.
                _d.apply(void 0, [(_j = (_m.sent())) === null || _j === void 0 ? void 0 : _j.text]).toMatch(/^● w-busy .*Working● w-done .*Done · report pending$/);
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'col1' })];
            case 12:
                _e.apply(void 0, [(_k = (_m.sent())) === null || _k === void 0 ? void 0 : _k.text]).toMatch(/^● w-stuck .*Reported$/);
                // Few workers: all show, and Details has nothing more.
                _f = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'workers' })];
            case 13:
                // Few workers: all show, and Details has nothing more.
                _f.apply(void 0, [(_l = (_m.sent())) === null || _l === void 0 ? void 0 : _l.text]).toBe('Details');
                return [4 /*yield*/, ui.unmount()];
            case 14:
                _m.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, names)];
            case 15:
                _m.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('compact shows the first two lines of workers; Details shows them all', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var clock, names, ui, _a, _b, _c, _i, names_2, name_2, _d, _e, _f;
    var _g, _h;
    return __generator(this, function (_j) {
        switch (_j.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                clock = (_j.sent()).clock;
                names = Array.from({ length: 10 }, function (_, i) { return "w".concat(String(i).padStart(2, '0')); });
                return [4 /*yield*/, (0, harness_1.spawn)($, names)];
            case 2:
                _j.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 3:
                _j.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 4:
                ui = _j.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, 'w03')];
            case 5:
                _a.apply(void 0, [_j.sent()]).toBeDefined();
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, 'w04')];
            case 6:
                _b.apply(void 0, [_j.sent()]).toBeUndefined();
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'workers' })];
            case 7:
                _c.apply(void 0, [(_g = (_j.sent())) === null || _g === void 0 ? void 0 : _g.text]).toBe('Details +6');
                return [4 /*yield*/, ui.press({ key: 'workers' })];
            case 8:
                _j.sent();
                _i = 0, names_2 = names;
                _j.label = 9;
            case 9:
                if (!(_i < names_2.length)) return [3 /*break*/, 12];
                name_2 = names_2[_i];
                _d = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, name_2)];
            case 10:
                _d.apply(void 0, [_j.sent()]).toBeDefined();
                _j.label = 11;
            case 11:
                _i++;
                return [3 /*break*/, 9];
            case 12:
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'workers' })];
            case 13:
                _e.apply(void 0, [(_h = (_j.sent())) === null || _h === void 0 ? void 0 : _h.text]).toBe('Compact');
                return [4 /*yield*/, ui.press({ key: 'workers' })];
            case 14:
                _j.sent();
                _f = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, 'w04')];
            case 15:
                _f.apply(void 0, [_j.sent()]).toBeUndefined();
                return [4 /*yield*/, ui.unmount()];
            case 16:
                _j.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, names)];
            case 17:
                _j.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a #123 links to the issue or PR of the repo named before it', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var clock, ui, hrefs, _a;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                clock = (_c.sent()).clock;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['b-srv'], '/srv')];
            case 2:
                _c.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 3:
                _c.sent();
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__pin_for_owner',
                        text: 'Merge client #565 and #566, then server #12 and web #4; see acme/other#3 and PR #9',
                    })
                    // A bare #7 from a worker takes the worker's repo.
                ];
            case 4:
                _c.sent();
                // A bare #7 from a worker takes the worker's repo.
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #7', from: 'b-srv' })];
            case 5:
                // A bare #7 from a worker takes the worker's repo.
                _c.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))
                    // A Link's found text is its href, then what it draws.
                ];
            case 6:
                ui = _c.sent();
                return [4 /*yield*/, ui.findAll({ type: 'Link' })];
            case 7:
                hrefs = (_c.sent()).map(function (l) { return "".concat(String(l.text).replace(String(l.props.href), ''), " ").concat(l.props.href); });
                (0, testing_1.expect)(hrefs).toEqual([
                    '#565 https://github.com/acme/app-client/issues/565',
                    '#566 https://github.com/acme/app-client/issues/566',
                    '#12 https://github.com/acme/app-server/issues/12',
                    '#4 https://github.com/acme/website/issues/4',
                    '#3 https://github.com/acme/other/issues/3',
                    '#9 https://github.com/acme/other/issues/9',
                    '#7 https://github.com/acme/app-server/issues/7',
                ]);
                // The line reads as written; only the #numbers are links.
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^Merge client/ })];
            case 8:
                // The line reads as written; only the #numbers are links.
                _a.apply(void 0, [(_b = (_c.sent())) === null || _b === void 0 ? void 0 : _b.text.replace(/https:\/\/github\.com\/[^#]+?\/issues\/\d+/g, '')]).toBe('Merge client #565 and #566, then server #12 and web #4; see acme/other#3 and PR #9');
                return [4 /*yield*/, ui.unmount()];
            case 9:
                _c.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['b-srv'])];
            case 10:
                _c.sent();
                return [2 /*return*/];
        }
    });
}); });
// It runs 10 minutes of ticks and sweeps, which a busy CI runner can take most of the default 5 s over.
(0, testing_1.test)('the band reads worker states from the waits and the sweep, under 3 herdr calls per worker-minute', { timeoutMs: 20000 }, function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, calls, emit, names, _i, names_3, name_3, ui, shown, _b, _c, names_4, name_4;
    var _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _f.sent(), clock = _a.clock, calls = _a.calls, emit = _a.emit;
                names = ['w-a', 'w-b', 'w-c'];
                return [4 /*yield*/, (0, harness_1.spawn)($, names)];
            case 2:
                _f.sent();
                _i = 0, names_3 = names;
                _f.label = 3;
            case 3:
                if (!(_i < names_3.length)) return [3 /*break*/, 6];
                name_3 = names_3[_i];
                return [4 /*yield*/, emit(name_3, 'working')];
            case 4:
                _f.sent();
                _f.label = 5;
            case 5:
                _i++;
                return [3 /*break*/, 3];
            case 6:
                calls.length = 0;
                return [4 /*yield*/, clock.advance(10 * 60000)
                    // No `agent get` per worker any more: one `agent list` a minute is all the herdr calls there are.
                ];
            case 7:
                _f.sent();
                // No `agent get` per worker any more: one `agent list` a minute is all the herdr calls there are.
                (0, testing_1.expect)(calls.filter(function (c) { return c[2] === 'get'; })).toEqual([]);
                (0, testing_1.expect)(calls.length / (names.length * 10)).toBeLessThan(3);
                // Exactly the sweep's list each minute: the 3 s ticks, the band and the report check add no call.
                (0, testing_1.expect)(calls.map(function (c) { return c.join(' '); })).toEqual(Array(10).fill('herdr agent list'));
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 8:
                ui = _f.sent();
                return [4 /*yield*/, ui.find({ key: 'col0' })];
            case 9:
                _b = [(_d = (_f.sent())) === null || _d === void 0 ? void 0 : _d.text];
                return [4 /*yield*/, ui.find({ key: 'col1' })];
            case 10:
                shown = _b.concat([(_e = (_f.sent())) === null || _e === void 0 ? void 0 : _e.text]).join('\n');
                for (_c = 0, names_4 = names; _c < names_4.length; _c++) {
                    name_4 = names_4[_c];
                    (0, testing_1.expect)(shown).toMatch(new RegExp("".concat(name_4, " +reviewer +\\S+ +Working")));
                }
                return [4 /*yield*/, ui.unmount()];
            case 11:
                _f.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, names)];
            case 12:
                _f.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)("one failed sweep keeps the band's last state", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, fail, ui, _b, _c;
    var _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _e.sent(), clock = _a.clock, fail = _a.fail;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-busy'])];
            case 2:
                _e.sent();
                return [4 /*yield*/, clock.advance(60000)
                    // herdr is down for the next minute: the sweep's list and every `agent get` fail. The band keeps
                    // the state it last saw, and no failed call shows the worker gone.
                ];
            case 3:
                _e.sent();
                // herdr is down for the next minute: the sweep's list and every `agent get` fail. The band keeps
                // the state it last saw, and no failed call shows the worker gone.
                fail.list = 100;
                // Only for the undone-change check: an agent get per row would turn these failed gets into Tab gone.
                fail.get = 100;
                return [4 /*yield*/, clock.advance(60000)];
            case 4:
                _e.sent();
                fail.list = 0;
                fail.get = 0;
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 5:
                ui = _e.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'col0' })];
            case 6:
                _b.apply(void 0, [(_d = (_e.sent())) === null || _d === void 0 ? void 0 : _d.text]).toMatch(/^● w-busy +reviewer +\S+ +Working$/);
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /Tab gone/ })];
            case 7:
                _c.apply(void 0, [_e.sent()]).toBeUndefined();
                return [4 /*yield*/, ui.unmount()];
            case 8:
                _e.sent();
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 9:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a status a wait or the sweep sees reaches the band row, with no agent get', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, calls, emit, status, band, _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _e.sent(), clock = _a.clock, calls = _a.calls, emit = _a.emit, status = _a.status;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-x'])];
            case 2:
                _e.sent();
                return [4 /*yield*/, emit('w-x', 'working')];
            case 3:
                _e.sent();
                calls.length = 0;
                band = function () { return __awaiter(void 0, void 0, void 0, function () {
                    var ui, text;
                    var _a, _b;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0: return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
                            case 1:
                                ui = _c.sent();
                                return [4 /*yield*/, ui.find({ key: 'col0' })];
                            case 2:
                                text = (_b = (_a = (_c.sent())) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : '';
                                return [4 /*yield*/, ui.unmount()];
                            case 3:
                                _c.sent();
                                return [2 /*return*/, text];
                        }
                    });
                }); };
                return [4 /*yield*/, clock.advance(3000)];
            case 4:
                _e.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, band()];
            case 5:
                _b.apply(void 0, [_e.sent()]).toMatch(/^● w-x +reviewer +\S+ +Working$/);
                // A wait ends on 'done' before any report: the band shows it at its next tick.
                return [4 /*yield*/, emit('w-x', 'done')];
            case 6:
                // A wait ends on 'done' before any report: the band shows it at its next tick.
                _e.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 7:
                _e.sent();
                _c = testing_1.expect;
                return [4 /*yield*/, band()];
            case 8:
                _c.apply(void 0, [_e.sent()]).toMatch(/^● w-x +reviewer +\S+ +Done · report pending$/);
                // Set without emit, so no wait ends on it: the sweep sees it a minute on, reports the worker blocked, and the row reads Reported.
                status['w-x'] = 'blocked';
                return [4 /*yield*/, clock.advance(60000)];
            case 9:
                _e.sent();
                _d = testing_1.expect;
                return [4 /*yield*/, band()];
            case 10:
                _d.apply(void 0, [_e.sent()]).toMatch(/^● w-x +reviewer +\S+ +Reported$/);
                (0, testing_1.expect)(calls.filter(function (c) { return c[2] === 'get'; })).toEqual([]);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-x'])];
            case 11:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
// The version is read once per mod folder and kept, so the unreadable case runs before the readable one.
(0, testing_1.test)("the band shows no version when the mod's plugin.json cannot be read", function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var ui, _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _c.sent();
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-busy'])];
            case 2:
                _c.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 3:
                ui = _c.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^v\d/ })];
            case 4:
                _a.apply(void 0, [_c.sent()]).toBeUndefined();
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, 'w-busy')];
            case 5:
                _b.apply(void 0, [_c.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 6:
                _c.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('the band ends its top row with the mod version, dim, after the context size', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var recorded, ui, _a, _b;
    var _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                recorded = (_d.sent()).recorded;
                recorded.modPlugin = JSON.stringify({ name: 'herdr-agents', version: '0.14.0' });
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-busy'])];
            case 2:
                _d.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 3:
                ui = _d.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^v\d/ })];
            case 4:
                _a.apply(void 0, [(_c = (_d.sent())) === null || _c === void 0 ? void 0 : _c.text]).toBe('v0.14.0');
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.row)(ui, 'w-busy')];
            case 5:
                _b.apply(void 0, [_d.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 6:
                _d.sent();
                return [2 /*return*/];
        }
    });
}); });
