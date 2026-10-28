"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var testing_1 = require("claude-code/testing");
var report_1 = require("../hooks/report");
var format_1 = require("../view/hooks/format");
// The report header a worker writes at the top of RESULT.md (report.ts), and how the coordinator reads it.
(0, testing_1.test)('a fenced header gives status, PRs, summary and ask, and what follows it is the rest', function () {
    var header = (0, report_1.parseHeader)([
        '```report',
        'status: blocked',
        'pr: 42',
        'summary: Opened PR #42, the checks pass.',
        '- The reviewer has not run yet.',
        'Waiting on the owner for the CI scope.',
        'ask: Base or develop?',
        '```',
        'Full text one.',
        'Full text two.',
    ].join('\n'));
    (0, testing_1.expect)(header).toEqual({
        status: 'blocked',
        prs: [42],
        summary: ['Opened PR #42, the checks pass.', 'The reviewer has not run yet.', 'Waiting on the owner for the CI scope.'],
        ask: 'Base or develop?',
        rest: 'Full text one.\nFull text two.',
    });
});
(0, testing_1.test)('a header without fences, with bold keys and a title before it, still parses', function () {
    var header = (0, report_1.parseHeader)('# T\n**Status:** Done\n**Summary:** a\n- b\n\nrest');
    (0, testing_1.expect)(header).toEqual({ status: 'done', prs: [], summary: ['a', 'b'], rest: '# T\n\nrest' });
});
(0, testing_1.test)('prose that starts with Status: and has no summary is not a header', function () {
    (0, testing_1.expect)((0, report_1.parseHeader)('# Report\n\nStatus: the candidate pack is built, not released.\n\n## What I did\nBuilt it.')).toBeUndefined();
});
(0, testing_1.test)('the summary keeps at most 3 lines, and a long line is cut to 240 characters', function () {
    var header = (0, report_1.parseHeader)(['status: done', "summary: ".concat('y'.repeat(300)), 'two', 'three', 'four'].join('\n'));
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.summary).toHaveLength(3);
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.summary[0]).toHaveLength(240);
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.summary.slice(1)).toEqual(['two', 'three']);
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.rest).toBe('four');
    // Repeated summary keys share the same 3 lines.
    var repeated = (0, report_1.parseHeader)(['status: done', 'summary: one', 'summary: two', 'summary: three', 'summary: four'].join('\n'));
    (0, testing_1.expect)(repeated === null || repeated === void 0 ? void 0 : repeated.summary).toEqual(['one', 'two', 'three']);
});
(0, testing_1.test)('pr takes several numbers or none, and prs is its alias', function () {
    var _a, _b, _c;
    (0, testing_1.expect)((_a = (0, report_1.parseHeader)('status: done\npr: #1006, https://github.com/o/r/pull/1007\nsummary: x')) === null || _a === void 0 ? void 0 : _a.prs).toEqual([1006, 1007]);
    (0, testing_1.expect)((_b = (0, report_1.parseHeader)('status: done\npr: none\nsummary: x')) === null || _b === void 0 ? void 0 : _b.prs).toEqual([]);
    (0, testing_1.expect)((_c = (0, report_1.parseHeader)('status: done\nprs: 12, 13\nsummary: x')) === null || _c === void 0 ? void 0 : _c.prs).toEqual([12, 13]);
});
(0, testing_1.test)('pr reads the PR numbers of its leading list, not the digits of a date or note after it', function () {
    var _a, _b, _c, _d, _e, _f;
    (0, testing_1.expect)((_a = (0, report_1.parseHeader)('status: done\npr: 42 (merged 2026-10-24)\nsummary: x')) === null || _a === void 0 ? void 0 : _a.prs).toEqual([42]);
    (0, testing_1.expect)((_b = (0, report_1.parseHeader)('status: done\npr: #1006, #1007 (merged 2026-10-24)\nsummary: x')) === null || _b === void 0 ? void 0 : _b.prs).toEqual([1006, 1007]);
    (0, testing_1.expect)((_c = (0, report_1.parseHeader)('status: done\npr: https://github.com/o/r/pull/42 (merged 2026-10-24)\nsummary: x')) === null || _c === void 0 ? void 0 : _c.prs).toEqual([42]);
    (0, testing_1.expect)((_d = (0, report_1.parseHeader)('status: done\npr: none (no PR, 2026-10-24)\nsummary: x')) === null || _d === void 0 ? void 0 : _d.prs).toEqual([]);
    (0, testing_1.expect)((_e = (0, report_1.parseHeader)('status: done\npr: 2026-10-24\nsummary: x')) === null || _e === void 0 ? void 0 : _e.prs).toEqual([]);
    // The list ends at the first word, so a number after it is not a PR.
    (0, testing_1.expect)((_f = (0, report_1.parseHeader)('status: done\npr: 42 merged 24 Oct\nsummary: x')) === null || _f === void 0 ? void 0 : _f.prs).toEqual([42]);
});
(0, testing_1.test)('a header that starts past line 12 is not read, one that starts within it is', function () {
    var _a;
    var preface = Array.from({ length: 12 }, function () { return 'Intro.'; }).join('\n');
    (0, testing_1.expect)((0, report_1.parseHeader)("".concat(preface, "\nstatus: done\nsummary: x"))).toBeUndefined();
    (0, testing_1.expect)((_a = (0, report_1.parseHeader)("".concat(preface.split('\n').slice(1).join('\n'), "\nstatus: done\nsummary: x"))) === null || _a === void 0 ? void 0 : _a.summary).toEqual(['x']);
});
(0, testing_1.test)('a status is read by its first word, and an unknown one is no status while the header stays valid', function () {
    var _a, _b;
    (0, testing_1.expect)((_a = (0, report_1.parseHeader)('status: Completed.\nsummary: x')) === null || _a === void 0 ? void 0 : _a.status).toBe('done');
    (0, testing_1.expect)((_b = (0, report_1.parseHeader)('status: error in CI\nsummary: x')) === null || _b === void 0 ? void 0 : _b.status).toBe('failed');
    var progress = (0, report_1.parseHeader)('status: in progress\nsummary: x');
    (0, testing_1.expect)(progress === null || progress === void 0 ? void 0 : progress.status).toBeUndefined();
    (0, testing_1.expect)(progress === null || progress === void 0 ? void 0 : progress.summary).toEqual(['x']);
});
(0, testing_1.test)('a fence with no closing fence ends the header at its last key; the lines after it are kept', function () {
    var header = (0, report_1.parseHeader)(['```report', 'status: done', 'summary: Did it.', 'ask: Base or develop?', '', 'Body line one.'].join('\n'));
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.summary).toEqual(['Did it.']);
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.ask).toBe('Base or develop?');
    (0, testing_1.expect)(header === null || header === void 0 ? void 0 : header.rest).toBe('Body line one.');
});
(0, testing_1.test)('an unknown key inside a fence is ignored and ends the summary', function () {
    var header = (0, report_1.parseHeader)(['```report', 'status: done', 'summary: Opened PR #42.', 'Checks: all green.', 'ask: Merge now?', '```'].join('\n'));
    (0, testing_1.expect)(header).toEqual({ status: 'done', prs: [], summary: ['Opened PR #42.'], ask: 'Merge now?', rest: '' });
});
(0, testing_1.test)('the inline form is the summary, the ask, the pinned questions and the pointer, in that order', function () {
    var header = (0, report_1.parseHeader)('status: blocked\nsummary: Opened it.\nask: Base or develop?\n\nLong text.');
    (0, testing_1.expect)((0, report_1.summaryOf)(header, '/w/RESULT-t1.md', 9, ['D1 [Port] Which port? | 5173 (recommended) | 8080'])).toBe('Opened it.\nAsk: Base or develop?\nD1 [Port] Which port? | 5173 (recommended) | 8080\n[Full report, 9 lines: /w/RESULT-t1.md. Read it only when this summary is not enough.]');
    // Nothing after the header: no pointer.
    var alone = (0, report_1.parseHeader)('status: done\nsummary: Done.');
    (0, testing_1.expect)((0, report_1.summaryOf)(alone, '/w/RESULT-t1.md', 2)).toBe('Done.');
});
(0, testing_1.test)('the view draws a header report with its result and PRs, and a report without one as before', function () {
    var headed = '<herdr-agent name="w-busy" profile="builder" status="done" result="blocked" pr="42,43">\nOpened PR #42.\nAsk: Base or develop?\n[Full report, 12 lines: /x/RESULT-t.md. Read it only when this summary is not enough.]\n</herdr-agent>';
    (0, testing_1.expect)((0, format_1.oneLine)(headed)).toBe('⇠ w-busy blocked: Opened PR #42. · full report in file · PR #42, #43');
    var plain = '<herdr-agent name="w-x" profile="builder" status="done">\nDone.\n</herdr-agent>';
    (0, testing_1.expect)((0, format_1.oneLine)(plain)).toBe('⇠ w-x done: Done.');
});
(0, testing_1.test)('the view draws a batch as one line: each element, and the worker count once after them', function () {
    var reports = [
        '<herdr-agent name="w-a" profile="builder" status="done">\nDone: approve.\n</herdr-agent>',
        '<herdr-agent name="w-b" profile="builder" status="blocked" result="blocked">\nStuck on CI.\n</herdr-agent>',
        "[0 of 4 workers working (waiting ones don't count). Start 4 more now from the Ready list in the state file.]",
    ];
    (0, testing_1.expect)((0, format_1.oneLine)(reports.join('\n\n'))).toBe('⇠ 2 updates: w-a done: Done: approve. · w-b blocked: Stuck on CI. · 0/4 working');
    // An owner's answer in the same batch keeps its own line.
    var answer = '<herdr-decision id="D3" from="w-a">\nQuestion: Ship it?\nThe owner chose: Yes\nIt is already unpinned.\n</herdr-decision>';
    (0, testing_1.expect)((0, format_1.oneLine)([reports[0], answer, reports[2]].join('\n\n'))).toBe('⇠ 2 updates: w-a done: Done: approve. · ◆ D3 owner chose: Yes · Ship it? · 0/4 working');
});
