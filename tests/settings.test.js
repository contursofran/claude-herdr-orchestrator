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
var harness_1 = require("./harness");
// /hrd-config: the settings listed on the band, saved to the user's or the folder's file.
(0, testing_1.test)('the settings on the band save to the chosen file and refuse bad values', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, files, _b, ui, user, _c, _d, _e, edit, _f, _g, _h, _j, _k, _l, _m, phone, _o, _p, _q;
    var _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1;
    return __generator(this, function (_2) {
        switch (_2.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on)];
            case 1:
                _a = _2.sent(), clock = _a.clock, files = _a.files;
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-config')];
            case 2:
                _b.apply(void 0, [(_2.sent()).text]).toMatch(/Settings are above the prompt: alt\+d/);
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 3:
                ui = _2.sent();
                user = function () { return JSON.parse(files['/home/t/.claude/herdr-agents.json']); };
                // A row per setting, its value on the right, as /config reads.
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-target' })];
            case 4:
                // A row per setting, its value on the right, as /config reads.
                _c.apply(void 0, [(_r = (_2.sent())) === null || _r === void 0 ? void 0 : _r.text]).toMatch(/^  Workers to keep busy +4 \(default\)$/);
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /Builder/ })];
            case 5:
                _d.apply(void 0, [(_s = (_2.sent())) === null || _s === void 0 ? void 0 : _s.text]).toMatch(/^  Builder +always on/);
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-off-builder' })];
            case 6:
                _e.apply(void 0, [_2.sent()]).toBeUndefined();
                edit = function (key, text) { return __awaiter(void 0, void 0, void 0, function () {
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, ui.press({ key: key })];
                            case 1:
                                _a.sent();
                                return [4 /*yield*/, ui.input({ key: 'cfg-edit', text: text })];
                            case 2:
                                _a.sent();
                                return [2 /*return*/];
                        }
                    });
                }); };
                return [4 /*yield*/, edit('cfg-target', '2')];
            case 7:
                _2.sent();
                (0, testing_1.expect)(user()).toEqual({ repos: { web: 'acme/website' }, target: 2 });
                _f = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /Saved target/ })];
            case 8:
                _f.apply(void 0, [(_t = (_2.sent())) === null || _t === void 0 ? void 0 : _t.text]).toBe('  Saved target = 2 in /home/t/.claude/herdr-agents.json.');
                _g = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-target' })];
            case 9:
                _g.apply(void 0, [(_u = (_2.sent())) === null || _u === void 0 ? void 0 : _u.text]).toMatch(/Workers to keep busy +2$/);
                return [4 /*yield*/, edit('cfg-target', 'lots')];
            case 10:
                _2.sent();
                _h = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /whole number/ })];
            case 11:
                _h.apply(void 0, [(_v = (_2.sent())) === null || _v === void 0 ? void 0 : _v.text]).toBe('  target must be a whole number of at least 1.');
                (0, testing_1.expect)(user().target).toBe(2);
                // Enter on the scope row switches to this folder's file; a switch there goes to it, and back on drops it.
                return [4 /*yield*/, ui.press({ key: 'cfg-scope' })];
            case 12:
                // Enter on the scope row switches to this folder's file; a switch there goes to it, and back on drops it.
                _2.sent();
                _j = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-scope' })];
            case 13:
                _j.apply(void 0, [(_w = (_2.sent())) === null || _w === void 0 ? void 0 : _w.text]).toMatch(/Edit settings for +this folder ›$/);
                // The hint line names the file the changes go to.
                _k = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /herdr-agents.json/ })];
            case 14:
                // The hint line names the file the changes go to.
                _k.apply(void 0, [(_x = (_2.sent())) === null || _x === void 0 ? void 0 : _x.text]).toBe('  /repo/.claude/herdr-agents.json');
                return [4 /*yield*/, ui.press({ key: 'cfg-off-reviewer' })];
            case 15:
                _2.sent();
                (0, testing_1.expect)(JSON.parse(files['/repo/.claude/herdr-agents.json'])).toEqual({ disable: ['reviewer'] });
                _l = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-off-reviewer' })];
            case 16:
                _l.apply(void 0, [(_y = (_2.sent())) === null || _y === void 0 ? void 0 : _y.text]).toMatch(/Reviewer +off/);
                return [4 /*yield*/, ui.press({ key: 'cfg-off-reviewer' })];
            case 17:
                _2.sent();
                (0, testing_1.expect)(JSON.parse(files['/repo/.claude/herdr-agents.json'])).toEqual({});
                // Small tasks steps from nobody through the profiles that are on.
                return [4 /*yield*/, ui.press({ key: 'cfg-smallTasks' })];
            case 18:
                // Small tasks steps from nobody through the profiles that are on.
                _2.sent();
                (0, testing_1.expect)(JSON.parse(files['/repo/.claude/herdr-agents.json'])).toEqual({ smallTasks: 'planner' });
                // An empty field drops the key from the file it edits.
                return [4 /*yield*/, ui.press({ key: 'cfg-scope' })];
            case 19:
                // An empty field drops the key from the file it edits.
                _2.sent();
                return [4 /*yield*/, edit('cfg-target', '')];
            case 20:
                _2.sent();
                (0, testing_1.expect)(user()).toEqual({ repos: { web: 'acme/website' } });
                // A file that is not valid JSON is left alone.
                files['/home/t/.claude/herdr-agents.json'] = '{ broken';
                return [4 /*yield*/, edit('cfg-resetAt', '150000')];
            case 21:
                _2.sent();
                (0, testing_1.expect)(files['/home/t/.claude/herdr-agents.json']).toBe('{ broken');
                _m = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /not valid JSON/ })];
            case 22:
                _m.apply(void 0, [(_z = (_2.sent())) === null || _z === void 0 ? void 0 : _z.text]).toMatch(/fix it by hand first/);
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'mobile' }))];
            case 23:
                phone = _2.sent();
                _o = testing_1.expect;
                return [4 /*yield*/, phone.find({ type: 'Text', text: /engine band/ })];
            case 24:
                _o.apply(void 0, [(_0 = (_2.sent())) === null || _0 === void 0 ? void 0 : _0.text]).toBe('engine band');
                return [4 /*yield*/, phone.unmount()
                    // Done gives the band back.
                ];
            case 25:
                _2.sent();
                // Done gives the band back.
                return [4 /*yield*/, ui.press({ key: 'cfg-done' })];
            case 26:
                // Done gives the band back.
                _2.sent();
                _p = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-target' })];
            case 27:
                _p.apply(void 0, [_2.sent()]).toBeUndefined();
                _q = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /engine band/ })];
            case 28:
                _q.apply(void 0, [(_1 = (_2.sent())) === null || _1 === void 0 ? void 0 : _1.text]).toBe('engine band');
                return [4 /*yield*/, ui.unmount()];
            case 29:
                _2.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 30:
                _2.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('view picks the band or the sidebar, opens it at start, and switches it from the settings', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, clock, files, panes, isSide, _b, ui, _c, _d, _e;
    var _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, harness_1.start)($, on, { view: 'side' })];
            case 1:
                _a = _g.sent(), clock = _a.clock, files = _a.files, panes = _a.panes;
                isSide = function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                    return [2 /*return*/, panes.includes('hrd-side')];
                }); }); };
                return [4 /*yield*/, clock.advance(10)];
            case 2:
                _g.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, isSide()];
            case 3:
                _b.apply(void 0, [_g.sent()]).toBe(true);
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-config')];
            case 4:
                _g.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({}, harness_1.BAND), { surface: 'terminal' }))];
            case 5:
                ui = _g.sent();
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ key: 'cfg-view' })];
            case 6:
                _c.apply(void 0, [(_f = (_g.sent())) === null || _f === void 0 ? void 0 : _f.text]).toMatch(/Show workers in +the sidebar ›$/);
                // The band is the default for all folders: the key goes, and the sidebar closes.
                return [4 /*yield*/, ui.press({ key: 'cfg-view' })];
            case 7:
                // The band is the default for all folders: the key goes, and the sidebar closes.
                _g.sent();
                (0, testing_1.expect)(JSON.parse(files['/home/t/.claude/herdr-agents.json'])).toEqual({ repos: { web: 'acme/website' } });
                _d = testing_1.expect;
                return [4 /*yield*/, isSide()];
            case 8:
                _d.apply(void 0, [_g.sent()]).toBe(false);
                return [4 /*yield*/, ui.press({ key: 'cfg-view' })];
            case 9:
                _g.sent();
                (0, testing_1.expect)(JSON.parse(files['/home/t/.claude/herdr-agents.json']).view).toBe('side');
                _e = testing_1.expect;
                return [4 /*yield*/, isSide()];
            case 10:
                _e.apply(void 0, [_g.sent()]).toBe(true);
                return [4 /*yield*/, ui.unmount()];
            case 11:
                _g.sent();
                return [4 /*yield*/, clock.advance(3000)];
            case 12:
                _g.sent();
                return [2 /*return*/];
        }
    });
}); });
