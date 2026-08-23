# tests/load — k6 benchmark

Built in P8. Not yet implemented.

k6 is run from the `grafana/k6` docker image. It is deliberately **not** an npm
dependency — the npm `k6` package is a stub that shells out to a binary you
still have to install, which makes the benchmark non-reproducible for a
reviewer.

Run:

```bash
docker run --rm -i --network=host -v "$PWD/scripts:/scripts" grafana/k6 run /scripts/<script>.js
```

Targets to measure, against `--profile=full` locally (brief §08, p95):

| Endpoint | Target |
| --- | --- |
| Room availability, 7 day range | < 300 ms |
| Cross venue search with combined filters | < 500 ms |
| Create hold | < 250 ms |
| Venue revenue report, 30 days | < 800 ms |

Results, plus `EXPLAIN ANALYZE` before and after indexing, plus the machine
spec, go in `LOAD_TEST.md`. The brief states the reviewer will re-run these
scripts from the repository, so the numbers must be reproducible rather than
merely reported.
