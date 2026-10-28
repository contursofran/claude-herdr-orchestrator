"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
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
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
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
exports.row = exports.BAND = void 0;
exports.start = start;
exports.spawn = spawn;
exports.until = until;
exports.stopAll = stopAll;
exports.command = command;
var testing_1 = require("claude-code/testing");
// What the tests share: the band's render props, and start(), which stands in for the
// engine beneath the mod (herdr, git, the file system) and starts a session in /repo.
exports.BAND = {
    plugin: 'herdr-agents',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 29 }, view: {} },
};
// herdr's state for the workers the tests name; a worker that starts without one is idle.
var STATUS = { 'w-busy': 'working', 'w-done': 'done', 'w-stuck': 'blocked' };
// The JSON herdr prints for a wait that ended with a status, and for a failed call.
var answer = function (name, status) {
    return JSON.stringify({ result: { agent: { agent_status: status, name: name, pane_id: "p-".concat(name), tab_id: "t-".concat(name) } } });
};
var failure = function (code, message) { return JSON.stringify({ error: { code: code, message: message } }); };
// Hooks that stand for the engine beneath the mod; returns the prompts the mod submitted
// to this session, the ones it typed into workers' tabs and the tabs it closed, and each
// worker's screen (by pane) and PR (by owner/name#123), which the test sets.
// `stored` is what $.store holds at the start, as an earlier load of the mod left it; `env` is
// merged over the session's environment (HOME, the herdr socket).
// The herdr fake: `calls` is every herdr argv the mod ran, `status` herdr's state per worker,
// and `emit`, `finish`, `kill` move a worker's wait (see below). `fail` makes the next
// calls fail, `gone` lists the workers herdr no longer knows.
function start($_1, on_1) {
    return __awaiter(this, arguments, void 0, function ($, on, config, stored, env) {
        var submitted, typed, closed, screens, prs, stalls, refuse, calls, shell, runs, status, fail, waits, end, Gone, gone, clock, _i, _a, _b, key, value, _c, _d, name_1, store, registered, CONFIG, files, recorded, panes, emit, finish, kill;
        var _e;
        var _this = this;
        var _f, _g;
        if (config === void 0) { config = {}; }
        if (stored === void 0) { stored = {}; }
        if (env === void 0) { env = {}; }
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    submitted = [];
                    typed = [];
                    closed = [];
                    screens = {};
                    prs = {};
                    stalls = {};
                    refuse = { next: 0 };
                    calls = [];
                    shell = [];
                    runs = new Map();
                    status = {};
                    fail = { list: 0, get: 0, pane: 0 };
                    waits = [];
                    end = function (match, code, out) {
                        for (var _i = 0, _a = waits.filter(match); _i < _a.length; _i++) {
                            var w = _a[_i];
                            waits.splice(waits.indexOf(w), 1);
                            w.end(code, out);
                        }
                    };
                    Gone = /** @class */ (function (_super) {
                        __extends(Gone, _super);
                        // The workers herdr no longer knows: adding one ends its pending waits as herdr would.
                        function Gone() {
                            return _super !== null && _super.apply(this, arguments) || this;
                        }
                        Gone.prototype.add = function (name) {
                            _super.prototype.add.call(this, name);
                            end(function (w) { return w.name === name; }, 1, failure('agent_not_found', "no agent named ".concat(name)));
                            return this;
                        };
                        return Gone;
                    }(Set));
                    gone = new Gone();
                    clock = testing_1.mock.clock(on, { now: 1000000 });
                    // The workers the stored jobs name are herdr's already, listed at their status.
                    for (_i = 0, _a = Object.entries(stored); _i < _a.length; _i++) {
                        _b = _a[_i], key = _b[0], value = _b[1];
                        if (key.startsWith('jobs:'))
                            for (_c = 0, _d = Object.keys((_f = value.jobs) !== null && _f !== void 0 ? _f : {}); _c < _d.length; _c++) {
                                name_1 = _d[_c];
                                status[name_1] = (_g = STATUS[name_1]) !== null && _g !== void 0 ? _g : 'idle';
                            }
                    }
                    store = new Map(Object.entries(stored).map(function (_a) {
                        var k = _a[0], v = _a[1];
                        return [k, JSON.parse(JSON.stringify(v))];
                    }));
                    on('store.get', function (_, e) { return ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }); });
                    on('store.set', function (_, e) {
                        store.set(e.key, JSON.parse(JSON.stringify(e.value)));
                        return { value: undefined };
                    });
                    on('store.delete', function (_, e) {
                        store.delete(e.key);
                        return { value: undefined };
                    });
                    on('store.keys', function () { return ({ value: __spreadArray([], store.keys(), true) }); });
                    // A turn the test starts or ends with $.turn: the plugin's hooks see it, and these answer it.
                    on('turn.start', function (_, e) { return ({ turnId: e.turnId }); });
                    on('turn.complete', function (_, e) { return ({ text: e.answer }); });
                    testing_1.mock.env(on, __assign({ HOME: '/home/t', HERDR_SOCKET_PATH: '/tmp/herdr.sock' }, env));
                    on('session.start', function (_, e) { return ({ cwd: e.cwd }); });
                    on('tool.register', function (_, e) { return ({ value: { tool: e.name } }); });
                    registered = [];
                    on('command.register', function (_, e) {
                        registered.push(e.name);
                        return { value: { command: e.name } };
                    });
                    on('ui.toast', function () { return ({ value: undefined }); });
                    on('session.id', function () { return ({ value: 'session-1234' }); });
                    CONFIG = '/home/t/.claude/herdr-agents.json';
                    files = (_e = {}, _e[CONFIG] = JSON.stringify(__assign({ repos: { web: 'acme/website' } }, config)), _e);
                    recorded = { clone: '/src/herdr', modPlugin: '' };
                    // A folder exists while a file is in it.
                    on('fs.exists', function (_, e) { return ({ value: e.path in files || Object.keys(files).some(function (f) { return f.startsWith("".concat(e.path, "/")); }) }); });
                    on('fs.list', function (_, e) { return ({
                        value: Object.keys(files)
                            .filter(function (f) { return f.startsWith("".concat(e.path, "/")) && !f.slice(e.path.length + 1).includes('/'); })
                            .map(function (f) { return ({ name: f.slice(e.path.length + 1), kind: 'file', size: files[f].length, mtimeMs: 0, isLink: false }); }),
                    }); });
                    // The mod's `clone` file is read from wherever the test loads the mod, so any path ending in /clone is it.
                    // Likewise the mod's own .claude-plugin/plugin.json (read for the band's version): recorded.modPlugin, unless the test put a file there.
                    on('fs.read', function (_, e) {
                        var _a;
                        return ({
                            value: e.path.endsWith('/clone')
                                ? recorded.clone
                                : ((_a = files[e.path]) !== null && _a !== void 0 ? _a : (e.path.endsWith('/.claude-plugin/plugin.json') ? recorded.modPlugin : '')),
                        });
                    });
                    on('fs.write', function (_, e) {
                        files[e.path] = e.text;
                        return { value: undefined };
                    });
                    panes = [];
                    on('ui.open', function (_, e) {
                        if (!panes.includes(e.id))
                            panes.push(e.id);
                        return { value: { isPlaced: true } };
                    });
                    on('ui.close', function (_, e) {
                        if (panes.includes(e.id))
                            panes.splice(panes.indexOf(e.id), 1);
                        return { value: undefined };
                    });
                    on('ui.panes', function () { return ({
                        value: panes.map(function (id) { return ({ id: id, title: id, isShown: true, isFocused: false, isPlaced: true, plugin: 'herdr-agents' }); }),
                    }); });
                    // The band's drawing when the mod passes: the engine's own.
                    on('ui.render', function ($, e) {
                        var Text = $.ui.resolve(e).Text;
                        return <Text>engine band</Text>;
                    });
                    on('process.run', function (_, e) {
                        var _a, _b, _c, _d, _e, _f, _g;
                        var _h = e.argv, cmd = _h[0], sub = _h[1], verb = _h[2], _j = _h[3], name = _j === void 0 ? '' : _j;
                        if (cmd === 'herdr')
                            calls.push(__spreadArray([], e.argv, true));
                        if (cmd !== 'herdr')
                            shell.push(e.argv.join(' '));
                        // The commands the test answers, in order: the last answer repeats.
                        var told = runs.get(e.argv.join(' '));
                        if (told) {
                            var reply = told.length > 1 ? told.shift() : told[0];
                            if (reply.reject)
                                return { deny: reply.reject };
                            return {
                                value: {
                                    exitCode: reply.exitCode,
                                    stdout: (_a = reply.stdout) !== null && _a !== void 0 ? _a : '',
                                    stderr: (_b = reply.stderr) !== null && _b !== void 0 ? _b : '',
                                    isStdoutTruncated: false,
                                    isStderrTruncated: false,
                                },
                            };
                        }
                        var exit = function (exitCode, stdout) {
                            if (stdout === void 0) { stdout = ''; }
                            return ({
                                value: { exitCode: exitCode, stdout: stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
                            });
                        };
                        var ok = function (result) { return exit(0, JSON.stringify({ result: result })); };
                        // /repo and /srv are GitHub checkouts; a folder in one (/repo/wt) is a worktree of it.
                        var remote = { '/repo': 'acme/app-client', '/srv': 'acme/app-server' };
                        var dir = "".concat((_c = e.argv[2]) !== null && _c !== void 0 ? _c : '', "/");
                        var slug = cmd === 'git' && e.argv[3] === 'remote' ? (_d = Object.entries(remote).find(function (_a) {
                            var d = _a[0];
                            return dir.startsWith("".concat(d, "/"));
                        })) === null || _d === void 0 ? void 0 : _d[1] : undefined;
                        if (slug)
                            return exit(0, "origin\tgit@github.com:".concat(slug, ".git (fetch)\n"));
                        if (cmd === 'gh' && sub === 'pr' && verb === 'view') {
                            var pr = prs["".concat(e.argv[5], "#").concat(name)];
                            return pr ? exit(0, JSON.stringify(pr)) : exit(1);
                        }
                        // The file moves and removals the bridge makes, on the files above.
                        if (cmd === 'mkdir')
                            return exit(0);
                        var _k = e.argv.slice(2).filter(function (a) { return !a.startsWith('-'); }), _l = _k[0], from = _l === void 0 ? '' : _l, _m = _k[1], to = _m === void 0 ? '' : _m;
                        if (cmd === 'mv' && from in files) {
                            files[to] = files[from];
                            delete files[from];
                            return exit(0);
                        }
                        if (cmd === 'rm') {
                            for (var _i = 0, _o = e.argv.slice(2).filter(function (a) { return !a.startsWith('-'); }); _i < _o.length; _i++) {
                                var p = _o[_i];
                                for (var _p = 0, _q = Object.keys(files); _p < _q.length; _p++) {
                                    var f = _q[_p];
                                    if (f === p || f.startsWith("".concat(p, "/")))
                                        delete files[f];
                                }
                            }
                            return exit(0);
                        }
                        if (cmd !== 'herdr')
                            return exit(1);
                        if (sub === 'agent' && verb === 'prompt') {
                            typed.push((_e = e.argv[4]) !== null && _e !== void 0 ? _e : '');
                            if (stalls[name]) {
                                stalls[name]--;
                                return exit(1, JSON.stringify({ error: { code: 'agent_prompt_stalled', message: 'no working state within 5000ms' } }));
                            }
                        }
                        if (sub === 'agent' && verb === 'start') {
                            status[name] = (_f = STATUS[name]) !== null && _f !== void 0 ? _f : 'idle';
                            gone.delete(name);
                            return ok({});
                        }
                        if (sub === 'agent' && verb === 'list') {
                            if (fail.list > 0) {
                                fail.list--;
                                return exit(1, failure('server_not_running', 'herdr is not running'));
                            }
                            var agents = Object.keys(status)
                                .filter(function (n) { return !gone.has(n) && !closed.includes("t-".concat(n)); })
                                .map(function (n) { return ({ name: n, agent_status: status[n], pane_id: "p-".concat(n), tab_id: "t-".concat(n) }); });
                            return ok({ agents: agents });
                        }
                        if (sub === 'agent' && verb === 'get') {
                            if (fail.get > 0) {
                                fail.get--;
                                return exit(1, failure('server_not_running', 'herdr is not running'));
                            }
                            if (gone.has(name) || status[name] === undefined)
                                return exit(1, failure('agent_not_found', "no agent named ".concat(name)));
                            if (closed.includes("t-".concat(name)))
                                return exit(1);
                            return ok({ agent: { agent_status: status[name], pane_id: "p-".concat(name), tab_id: "t-".concat(name) } });
                        }
                        if (sub === 'tab' && verb === 'close') {
                            closed.push(name);
                            end(function (w) { return "t-".concat(w.name) === name; }, 1, failure('agent_not_running', 'agent is no longer running in the target pane'));
                        }
                        if (sub === 'pane' && verb === 'read') {
                            if (fail.pane > 0) {
                                fail.pane--;
                                return exit(1, failure('server_not_running', 'herdr is not running'));
                            }
                            return exit(0, (_g = screens[name]) !== null && _g !== void 0 ? _g : '');
                        }
                        if (sub === 'tab' && verb === 'create')
                            return ok({ root_pane: { pane_id: 'p1' } });
                        return ok({});
                    });
                    // `herdr agent wait` runs as a child process. Like herdr's wait, it answers at once when the worker
                    // is already in one of its --until states; otherwise it is held until emit, kill, a closed tab or
                    // gone ends it. Any other child exits 1.
                    on('process.spawn', function (_, e) {
                        return __asyncGenerator(this, arguments, function () {
                            var _a, cmd, sub, verb, _b, name, until, now, reply;
                            return __generator(this, function (_c) {
                                switch (_c.label) {
                                    case 0:
                                        calls.push(__spreadArray([], e.argv, true));
                                        _a = e.argv, cmd = _a[0], sub = _a[1], verb = _a[2], _b = _a[3], name = _b === void 0 ? '' : _b;
                                        if (!(cmd !== 'herdr' || sub !== 'agent' || verb !== 'wait')) return [3 /*break*/, 2];
                                        return [4 /*yield*/, __await({ value: { code: 1, signal: null } })];
                                    case 1: return [2 /*return*/, _c.sent()];
                                    case 2:
                                        until = e.argv.flatMap(function (arg, i) { return (arg === '--until' && e.argv[i + 1] !== undefined ? [e.argv[i + 1]] : []); });
                                        now = status[name];
                                        if (!(now === undefined || gone.has(name))) return [3 /*break*/, 6];
                                        return [4 /*yield*/, __await({ stream: 'stdout', text: failure('agent_not_found', "no agent named ".concat(name)) })];
                                    case 3: return [4 /*yield*/, _c.sent()];
                                    case 4:
                                        _c.sent();
                                        return [4 /*yield*/, __await({ value: { code: 1, signal: null } })];
                                    case 5: return [2 /*return*/, _c.sent()];
                                    case 6:
                                        if (!until.includes(now)) return [3 /*break*/, 10];
                                        return [4 /*yield*/, __await({ stream: 'stdout', text: answer(name, now) })];
                                    case 7: return [4 /*yield*/, _c.sent()];
                                    case 8:
                                        _c.sent();
                                        return [4 /*yield*/, __await({ value: { code: 0, signal: null } })];
                                    case 9: return [2 /*return*/, _c.sent()];
                                    case 10: return [4 /*yield*/, __await(new Promise(function (resolve) {
                                            return waits.push({ name: name, until: until, end: function (code, out) { return resolve({ code: code, out: out }); } });
                                        }))];
                                    case 11:
                                        reply = _c.sent();
                                        return [4 /*yield*/, __await({ stream: 'stdout', text: reply.out })];
                                    case 12: return [4 /*yield*/, _c.sent()];
                                    case 13:
                                        _c.sent();
                                        return [4 /*yield*/, __await({ value: { code: reply.code, signal: null } })];
                                    case 14: return [2 /*return*/, _c.sent()];
                                }
                            });
                        });
                    });
                    on('prompt.submit', function (_, e) {
                        if (refuse.next > 0) {
                            refuse.next--;
                            throw new Error('the session refused the prompt');
                        }
                        submitted.push(e.text);
                        return { text: e.text };
                    });
                    emit = function (name, next) { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    status[name] = next;
                                    end(function (w) { return w.name === name && w.until.includes(next); }, 0, answer(name, next));
                                    return [4 /*yield*/, clock.settle()];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/];
                            }
                        });
                    }); };
                    finish = function (name) { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, emit(name, 'working')];
                                case 1:
                                    _a.sent();
                                    return [4 /*yield*/, emit(name, 'done')];
                                case 2:
                                    _a.sent();
                                    return [2 /*return*/];
                            }
                        });
                    }); };
                    kill = function (name) { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    end(function (w) { return w.name === name; }, 1, failure('agent_not_running', 'agent is no longer running in the target pane'));
                                    return [4 /*yield*/, clock.settle()];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/];
                            }
                        });
                    }); };
                    return [4 /*yield*/, $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })];
                case 1:
                    _h.sent();
                    return [2 /*return*/, {
                            clock: clock,
                            submitted: submitted,
                            typed: typed,
                            closed: closed,
                            screens: screens,
                            files: files,
                            prs: prs,
                            panes: panes,
                            stalls: stalls,
                            refuse: refuse,
                            store: store,
                            calls: calls,
                            shell: shell,
                            runs: runs,
                            recorded: recorded,
                            registered: registered,
                            status: status,
                            fail: fail,
                            gone: gone,
                            emit: emit,
                            finish: finish,
                            kill: kill,
                        }];
            }
        });
    });
}
// A row is one Text per column; its name is padded.
var row = function (ui, name) { return ui.find({ type: 'Text', text: new RegExp("^".concat(name, " +$")) }); };
exports.row = row;
function spawn($, names, cwd) {
    return __awaiter(this, void 0, void 0, function () {
        var _i, names_1, worker;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _i = 0, names_1 = names;
                    _a.label = 1;
                case 1:
                    if (!(_i < names_1.length)) return [3 /*break*/, 4];
                    worker = names_1[_i];
                    return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: worker, profile: 'reviewer', cwd: cwd !== null && cwd !== void 0 ? cwd : "/repo-".concat(worker), task: 'x' })];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// Settles until `done` holds, up to 200 times. Work the mod leaves running unawaited (a refresh
// learning a repo's remote, the sidebar's PR poll) waits on a process.run answer that can land
// after clock.settle() returns on a busy machine; the test's expect then checks it.
function until(clock, done) {
    return __awaiter(this, void 0, void 0, function () {
        var i, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    i = 0;
                    _b.label = 1;
                case 1:
                    _a = i < 200;
                    if (!_a) return [3 /*break*/, 3];
                    return [4 /*yield*/, done()];
                case 2:
                    _a = !(_b.sent());
                    _b.label = 3;
                case 3:
                    if (!_a) return [3 /*break*/, 6];
                    return [4 /*yield*/, clock.settle()];
                case 4:
                    _b.sent();
                    _b.label = 5;
                case 5:
                    i++;
                    return [3 /*break*/, 1];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// Their watch loops end before the test does.
function stopAll($, clock, names) {
    return __awaiter(this, void 0, void 0, function () {
        var _i, names_2, worker;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _i = 0, names_2 = names;
                    _a.label = 1;
                case 1:
                    if (!(_i < names_2.length)) return [3 /*break*/, 4];
                    worker = names_2[_i];
                    return [4 /*yield*/, $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: worker })];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4: return [4 /*yield*/, clock.advance(10000)];
                case 5:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// Runs one of the mod's commands as the person typing it; the engine stamps where the
// run came from and how it is shown, so the test leaves those out.
function command($_1, name_2) {
    return __awaiter(this, arguments, void 0, function ($, name, args) {
        if (args === void 0) { args = ''; }
        return __generator(this, function (_a) {
            return [2 /*return*/, $.command.run({ command: name, args: args })];
        });
    });
}
