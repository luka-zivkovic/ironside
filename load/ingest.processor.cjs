// Artillery processor: reads the pre-seeded API key from IRONSIDE_LOAD_TEST_KEY
// (set by load/run.sh after seeding a dedicated load-test project) and builds
// a fresh single-trace ingest body per virtual user request.
let counter = 0;

function setBody(requestParams, context, ee, next) {
  context.vars.apiKey = process.env.IRONSIDE_LOAD_TEST_KEY;
  counter += 1;
  requestParams.json = {
    events: [
      {
        type: "trace-upsert",
        body: {
          id: `trace_load_${process.pid}_${counter}_${Date.now()}`,
          timestamp: new Date().toISOString(),
          name: "load-test",
          metadata: { run: "artillery" }
        }
      }
    ]
  };
  return next();
}

module.exports = { setBody };
