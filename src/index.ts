import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import {
  StringOutputParser,
  StructuredOutputParser,
} from "@langchain/core/output_parsers";
import { OutputFixingParser } from "langchain/output_parsers";
import { ConsoleCallbackHandler } from "langchain/callbacks";
import minimist from "minimist";
import { z } from "zod";
import {
  COMMAND_PREDICTION_SYSTEM_PROMPT,
  GENERAL_QUESTION_SYSTEM_PROMPT,
} from "./prompts";
import { Runnable } from "@langchain/core/runnables";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { execSync, spawn } from "child_process";

const SHELLM_OPENAI_MODEL = process.env.SHELLM_OPENAI_MODEL || "gpt-4o-mini";
const AnswerSchema = z.object({
  recommendCommand: z.string(),
});

const DEBUG = process.env.DEBUG === "true";

type Answer = z.infer<typeof AnswerSchema>;

async function main(args: string[]) {
  assertEnv();
  assertTmux();

  const { _, q } = minimist(args.slice(2), { boolean: ["q"] });

  const model = new ChatOpenAI({ model: SHELLM_OPENAI_MODEL, temperature: 0 });
  const context = getContext();

  const question = _.join(" ");
  if (q) {
    const chain = GeneralQuestionChain(model);
    const answer = await chain.invoke({ context, intent: question });
    console.log(answer);
    return;
  } else {
    const chain = CommandRecommendChain(model);
    const answer = await chain.invoke(
      { context, intent: question },
      DEBUG ? { callbacks: [new ConsoleCallbackHandler()] } : {},
    );
    console.log(`
Recommended Command: \`${answer.recommendCommand}\`
`);
    const pressed = await scanPressButton();
    if (pressed === "y") {
      pbcopy(answer.recommendCommand);
      console.log("Command copied to clipboard, paste it in your terminal");
      return;
    }
    if (pressed === "q") {
      return;
    }
  }
}

async function scanPressButton(): Promise<"y" | "q"> {
  console.log(`
Press the button for below actions:
- y: Copy the command to clipboard
- q: Quit
`);
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data: Buffer) => {
      const str = data.toString();
      if (str === "y" || str === "q") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(str as "y" | "q");
      }
    };

    process.stdin.on("data", onData);

    process.on("SIGINT", () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve("q");
    });
  });
}

function pbcopy(data: string) {
  const proc = require("child_process").spawn("pbcopy");
  proc.stdin.write(data);
  proc.stdin.end();
}

function getContext() {
  return execSync(`tmux capture-pane -p`).toString().trim();
}

function CommandRecommendChain(model: BaseChatModel) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", COMMAND_PREDICTION_SYSTEM_PROMPT],
    ["human", "{intent}"],
  ]);

  const jsonParser = StructuredOutputParser.fromZodSchema(AnswerSchema);
  const outputParser = OutputFixingParser.fromLLM(model, jsonParser);

  const chain: Runnable<{ context: string; intent: string }, Answer> = prompt
    .pipe(model)
    .pipe(outputParser);

  return chain;
}

function GeneralQuestionChain(model: BaseChatModel) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", GENERAL_QUESTION_SYSTEM_PROMPT],
    ["human", "{intent}"],
  ]);
  const parser = new StringOutputParser();
  return prompt.pipe(model).pipe(parser);
}

function assertTmux(): void {
  if (!process.env.TMUX) {
    throw new Error("It should be run inside tmux");
  }
}

function assertEnv() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set");
    process.exit(1);
  }
}

main(process.argv);
