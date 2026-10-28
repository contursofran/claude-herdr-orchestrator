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
// The board for apps outside Claude Code: a snapshot file per session, and action files
// that press the sidebar's buttons.
var DIR = '/home/t/.herdr-agents/board';
var FILE = "".concat(DIR, "/session-1234.json");
var INBOX = "".concat(DIR, "/session-1234.actions");
(0, testing_1.test)('the board is written for outside apps, and their action files answer and tick as the sidebar does', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, submitted, files, board, d1, after;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _e.sent(), clock = _a.clock, submitted = _a.submitted, files = _a.files;
                return [4 /*yield*/, (0, harness_1.spawn)($, ['w-busy'])];
            case 2:
                _e.sent();
                return [4 /*yield*/, $.tool.call({
                        tool: 'mcp__herdr-agents__ask_owner',
                        question: 'Sort bags by type or by weight?',
                        title: 'Bag sort',
                        options: ['By type', 'By weight'],
                        recommended: 0,
                        from: 'p-640',
                    })];
            case 3:
                _e.sent();
                return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #642 at localhost:5173', kind: 'do', from: 'r-642' })];
            case 4:
                _e.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 5:
                _e.sent();
                board = JSON.parse((_b = files[FILE]) !== null && _b !== void 0 ? _b : '{}');
                (0, testing_1.expect)(board.version).toBe(1);
                (0, testing_1.expect)(board.stageNames).toEqual(['plan', 'build', 'rev', 'CI', 'you']);
                (0, testing_1.expect)(board.workers.map(function (w) { return w.name; })).toEqual(['w-busy']);
                (0, testing_1.expect)(board.summary.needs).toBe(2);
                d1 = board.needs.find(function (n) { return n.key === 'D1'; });
                (0, testing_1.expect)(d1).toMatchObject({ kind: 'ask', title: 'Bag sort', isOpen: true, options: ['By type', 'By weight'], recommended: 0 });
                (0, testing_1.expect)(board.needs.find(function (n) { return n.key === 'T1'; })).toMatchObject({ kind: 'do', isOpen: true, url: 'localhost:5173' });
                (0, testing_1.expect)("".concat(FILE, ".tmp") in files).toBe(false);
                files["".concat(INBOX, "/1-answer.json")] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'By type' });
                files["".concat(INBOX, "/2-done.json")] = JSON.stringify({ action: 'done', key: 'T1' });
                files["".concat(INBOX, "/3-stale.json")] = JSON.stringify({ action: 'answer', key: 'D9', answer: 'x' });
                return [4 /*yield*/, clock.advance(3000 + defaults_1.BATCH_MS)
                    // The coordinator gets the same prompts as from the sidebar.
                ];
            case 6:
                _e.sent();
                // The coordinator gets the same prompts as from the sidebar.
                (0, testing_1.expect)(submitted.some(function (t) { return t.includes('<herdr-decision id="D1"') && t.includes('The owner chose: By type'); })).toBe(true);
                (0, testing_1.expect)(submitted.some(function (t) { return t.includes('<herdr-owner-done id="T1"'); })).toBe(true);
                after = JSON.parse((_c = files[FILE]) !== null && _c !== void 0 ? _c : '{}');
                (0, testing_1.expect)(after.needs.find(function (n) { return n.key === 'D1'; })).toMatchObject({ isOpen: false, end: 'By type' });
                (0, testing_1.expect)(after.needs.find(function (n) { return n.key === 'T1'; })).toMatchObject({ isOpen: false, end: 'done' });
                (0, testing_1.expect)(after.summary.needs).toBe(0);
                (0, testing_1.expect)(after.actions).toEqual([
                    { id: '1-answer.json', ok: true, message: 'D1 → By type' },
                    { id: '2-done.json', ok: true, message: 'T1 done' },
                    { id: '3-stale.json', ok: false, message: 'D9 is not an open decision' },
                ]);
                (0, testing_1.expect)(Object.keys(files).filter(function (f) { return f.startsWith("".concat(INBOX, "/")); })).toEqual([]);
                // Clear done takes the closed items off, as the sidebar's button does.
                files["".concat(INBOX, "/4-clear.json")] = JSON.stringify({ action: 'clearDone', what: 'items' });
                return [4 /*yield*/, clock.advance(3000)];
            case 7:
                _e.sent();
                (0, testing_1.expect)(JSON.parse((_d = files[FILE]) !== null && _d !== void 0 ? _d : '{}').needs).toEqual([]);
                return [4 /*yield*/, (0, harness_1.stopAll)($, clock, ['w-busy'])];
            case 8:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
