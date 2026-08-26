// A minimal chatbot backend. Every line prefixed "// [ironside]" is one of
// the exactly 3 lines added to instrument it — everything else is the
// chatbot as it would exist with zero observability.
//
// Run: IRONSIDE_API_KEY=... node index.js
// (start `docker compose up` and `pnpm --filter @ironside/api seed` first
// to get a key against a local Ironside instance)

import { init, wrapOpenAI } from "ironside"; // [ironside] line 1

const ironside = init({
  // [ironside] line 2
  apiKey: process.env.IRONSIDE_API_KEY,
  host: process.env.IRONSIDE_HOST ?? "http://localhost:8788"
});

// Stand-in for `new OpenAI({apiKey})` — this example has no real OpenAI
// key, so it fakes the client's shape. wrapOpenAI() only cares about the
// `chat.completions.create()` method existing; swap this for a real
// `import OpenAI from "openai"; new OpenAI({apiKey: ...})` in a real app.
const openai = {
  chat: {
    completions: {
      async create({ model, messages }) {
        const userMessage = messages.at(-1)?.content ?? "";
        return {
          model,
          choices: [{ message: { role: "assistant", content: `You said: "${userMessage}"` } }],
          usage: { prompt_tokens: userMessage.length, completion_tokens: 12, total_tokens: userMessage.length + 12 }
        };
      }
    }
  }
};

const client = wrapOpenAI(openai, ironside); // [ironside] line 3

async function handleChatMessage(userId, message) {
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: message }]
  });
  return completion.choices[0].message.content;
}

async function main() {
  const reply = await handleChatMessage("user_demo", "Hello, chatbot!");
  console.log("chatbot reply:", reply);

  // Recording feedback/eval results: not part of the 3-line
  // instrumentation, but every trace/observation handle exposes score()
  // for capturing human feedback or eval results — the SDK equivalent of
  // what the LangFuse/LangSmith importers pull in as Score rows. Attach
  // the call to an explicit trace (via wrapOpenAI's `trace` option) so you
  // have a handle to score afterwards, e.g. once a user clicks thumbs-up.
  const feedbackTrace = ironside.trace({ name: "chat-message", userId: "user_demo" });
  const feedbackClient = wrapOpenAI(openai, ironside, { trace: feedbackTrace });
  await feedbackClient.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Was that helpful?" }]
  });
  feedbackTrace.score({ name: "thumbs-up", value: 1 });

  // Not part of the 3-line instrumentation — shutdown() is a normal
  // graceful-shutdown call, same category as closing a DB pool.
  await ironside.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
