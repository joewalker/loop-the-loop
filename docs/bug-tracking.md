# Bug Tracking

We track bugs as issues in this [project's GitHub repository](https://github.com/joewalker/loop-the-loop/issues).

## Severity levels

We classify bugs on a four-point severity scale, S1 through S4. Severity describes the impact of the bug on consumers of the library.

### S1: Security problems, data corruption risks or silent wrong results

The defining property of an S1 is a problem whose consequences extend beyond the scope of the initial API call. S1 issues include:

- Security issues that allow malformed input to influence results in unintended ways
- Bugs that cause the system to degrade due to corrupted data
- Cases where the a consumer using the library according to its documented contract receives a result that is wrong, with no error or warning to indicate the problem

### S2: API bugs and crashes, or misleading behavior likely to affect callers

The defining property of S2 is that a reasonable caller writing reasonable code will hit the problem and notice. S2 issues include:

- Instances where the API behaves incorrectly when called with valid arguments
- Severe performance problems that prevent use of the API

### S3: Edge case, confusing API, maintainability issue, or moderate performance problem

Issues in this band do not block correct use of the library but make it harder than it should be. S3 issues include:

- Bugs that only trigger in narrow edge cases
- Performance issues that are merely annoying

### S4: Cleanup or nit with low behavioral risk

S4 issues will generally not be noticed by users. S4 issues include:

- Stylistic, cosmetic, or housekeeping items
- Deprecated method calls that still work
- Theoretical performance issues

## Working with issues

When filing an issue, lead with the observed behavior, the expected behavior, and a minimal reproduction. Add the severity in a label (`S1`, `S2`, `S3`, or `S4`) so the backlog can be sorted by impact.
