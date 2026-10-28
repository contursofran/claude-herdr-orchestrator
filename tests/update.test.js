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
var harness_1 = require("./harness");
// /hrd-update: pulls the clone install.sh recorded, runs its install.sh, and answers in one line.
var CLONE = '/src/herdr';
var HEAD = "git -C ".concat(CLONE, " rev-parse --short HEAD");
var PULL = "git -C ".concat(CLONE, " pull --ff-only");
var INSTALL = "".concat(CLONE, "/install.sh");
var VERSION = "".concat(CLONE, "/.claude-plugin/plugin.json");
var ok = function (stdout) {
    if (stdout === void 0) { stdout = ''; }
    return ({ exitCode: 0, stdout: stdout });
};
var failed = function (stderr) { return ({ exitCode: 1, stderr: stderr }); };
// The mod loaded in a session whose start-up work has run, so nothing of it is left for the test's end.
function session() {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    return __awaiter(this, void 0, void 0, function () {
        var started;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, harness_1.start.apply(void 0, args)];
                case 1:
                    started = _a.sent();
                    return [4 /*yield*/, started.clock.advance(3000)];
                case 2:
                    _a.sent();
                    return [2 /*return*/, started];
            }
        });
    });
}
// The commands run in the clone since `mark`; the board's own git calls in /repo are left out.
var ranInClone = function (shell, mark) { return shell.slice(mark).filter(function (argv) { return argv.includes(CLONE); }); };
// The answers to an update: the commit before the pull and after it, and how the pull and install.sh end.
function clone(runs, _a) {
    var before = _a.before, after = _a.after, _b = _a.pull, pull = _b === void 0 ? ok() : _b, _c = _a.install, install = _c === void 0 ? ok() : _c;
    runs.set(HEAD, [ok("".concat(before, "\n")), ok("".concat(after, "\n"))]);
    runs.set(PULL, [pull]);
    runs.set(INSTALL, [install]);
}
(0, testing_1.test)('hrd-update pulls the recorded clone, runs its install.sh and says the commits and version it reached', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, files, runs, shell, mark, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                _a = _c.sent(), files = _a.files, runs = _a.runs, shell = _a.shell;
                files[VERSION] = JSON.stringify({ name: 'herdr-agents', version: '0.12.1' });
                clone(runs, { before: 'abc1234', after: 'def5678', pull: ok('Updating abc1234..def5678\n') });
                mark = shell.length;
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _b.apply(void 0, [(_c.sent()).text]).toBe('herdr-agents updated from abc1234 to def5678, version 0.12.1. Installed; running sessions reload it by themselves.');
                (0, testing_1.expect)(ranInClone(shell, mark)).toEqual([HEAD, PULL, HEAD, INSTALL]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('when the pull brings nothing new, install.sh still runs and the answer says it is up to date', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, files, runs, shell, mark, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                _a = _c.sent(), files = _a.files, runs = _a.runs, shell = _a.shell;
                files[VERSION] = JSON.stringify({ name: 'herdr-agents', version: '0.12.1' });
                clone(runs, { before: 'abc1234', after: 'abc1234', pull: ok('Already up to date.\n') });
                mark = shell.length;
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _b.apply(void 0, [(_c.sent()).text]).toBe('herdr-agents is up to date at abc1234, version 0.12.1. install.sh ran again; running sessions reload it by themselves.');
                (0, testing_1.expect)(ranInClone(shell, mark)).toEqual([HEAD, PULL, HEAD, INSTALL]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('with no clone recorded, nothing runs and the answer says why', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, recorded, shell, mark, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                _a = _c.sent(), recorded = _a.recorded, shell = _a.shell;
                recorded.clone = '';
                mark = shell.length;
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _b.apply(void 0, [(_c.sent()).text]).toBe('Nothing updated: no clone is recorded for herdr-agents. Run ./install.sh from your clone once.');
                (0, testing_1.expect)(ranInClone(shell, mark)).toEqual([]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a failed pull stops before install.sh, and the answer carries the last three lines of its stderr', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, runs, shell, mark, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                _a = _c.sent(), runs = _a.runs, shell = _a.shell;
                clone(runs, {
                    before: 'abc1234',
                    after: 'abc1234',
                    pull: failed('From github.com:acme/herdr\nerror: divergent branches\nerror: cannot fast-forward\nfatal: Not possible to fast-forward, aborting.\n'),
                });
                mark = shell.length;
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _b.apply(void 0, [(_c.sent()).text]).toBe('Update stopped: git pull --ff-only failed in /src/herdr, install.sh did not run: ' +
                    'error: divergent branches / error: cannot fast-forward / fatal: Not possible to fast-forward, aborting.');
                (0, testing_1.expect)(ranInClone(shell, mark)).toEqual([HEAD, PULL]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a failed install.sh says so with the last lines of its stderr', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var runs, _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                runs = (_b.sent()).runs;
                clone(runs, { before: 'abc1234', after: 'def5678', install: failed('rsync: command not found\n') });
                _a = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _a.apply(void 0, [(_b.sent()).text]).toBe('Update stopped: install.sh failed in /src/herdr: rsync: command not found');
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a failed step with nothing on its stderr says so', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var runs, _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                runs = (_b.sent()).runs;
                clone(runs, { before: 'abc1234', after: 'def5678', install: { exitCode: 2 } });
                _a = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _a.apply(void 0, [(_b.sent()).text]).toBe('Update stopped: install.sh failed in /src/herdr: no output on stderr');
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('a command that cannot start fails its step, with the error as its reason', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, runs, shell, mark, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                _a = _c.sent(), runs = _a.runs, shell = _a.shell;
                clone(runs, { before: 'abc1234', after: 'abc1234', pull: { exitCode: 1, reject: 'spawn git ENOENT' } });
                mark = shell.length;
                _b = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-update')];
            case 2:
                _b.apply(void 0, [(_c.sent()).text]).toMatch(/^Update stopped: git pull --ff-only failed in \/src\/herdr, install.sh did not run: .*spawn git ENOENT$/);
                (0, testing_1.expect)(ranInClone(shell, mark)).toEqual([HEAD, PULL]);
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('the command is registered, and the guide lists it', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var registered, _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, session($, on)];
            case 1:
                registered = (_b.sent()).registered;
                (0, testing_1.expect)(registered).toContain('hrd-update');
                _a = testing_1.expect;
                return [4 /*yield*/, (0, harness_1.command)($, 'hrd-h')];
            case 2:
                _a.apply(void 0, [(_b.sent()).text]).toMatch(/\/hrd-update +pull the clone this mod was installed from, and install it again/);
                return [2 /*return*/];
        }
    });
}); });
