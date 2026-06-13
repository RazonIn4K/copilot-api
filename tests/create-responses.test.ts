import { describe, expect, test } from "bun:test"

import {
  responseEventToChatChunks,
  responseToChatCompletion,
  shouldUseResponsesEndpoint,
  type ResponseApiResponse,
  type ResponsesStreamState,
} from "~/services/copilot/create-responses"

describe("Responses API adapter", () => {
  test("uses responses only for models that do not support chat completions", () => {
    expect(shouldUseResponsesEndpoint(["/responses"])).toBe(true)
    expect(
      shouldUseResponsesEndpoint(["/responses", "/chat/completions"]),
    ).toBe(false)
    expect(shouldUseResponsesEndpoint(["/chat/completions"])).toBe(false)
    expect(shouldUseResponsesEndpoint()).toBe(false)
  })

  test("converts a non-streaming response to a chat completion", () => {
    const response: ResponseApiResponse = {
      id: "resp_123",
      object: "response",
      created_at: 1700000000,
      model: "gpt-test",
      status: "completed",
      output: [
        {
          content: [
            { type: "output_text", text: "Hello" },
            { type: "output_text", text: " there" },
          ],
        },
      ],
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
      },
    }

    const chatCompletion = responseToChatCompletion(response)

    expect(chatCompletion.id).toBe("resp_123")
    expect(chatCompletion.object).toBe("chat.completion")
    expect(chatCompletion.choices[0].message.content).toBe("Hello there")
    expect(chatCompletion.choices[0].finish_reason).toBe("stop")
    expect(chatCompletion.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    })
  })

  test("converts response stream events to chat completion chunks", () => {
    const streamState: ResponsesStreamState = {
      id: "",
      model: "gpt-test",
      created: 0,
      roleSent: false,
    }

    expect(
      responseEventToChatChunks(
        JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_123",
            object: "response",
            created_at: 1700000000,
            model: "gpt-test",
            status: "in_progress",
          },
        }),
        streamState,
      ),
    ).toEqual([])

    const deltaChunks = responseEventToChatChunks(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Hello",
      }),
      streamState,
    )

    expect(deltaChunks).toHaveLength(1)
    expect(deltaChunks[0]).toMatchObject({
      id: "resp_123",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            role: "assistant",
            content: "Hello",
          },
          finish_reason: null,
        },
      ],
    })

    const completedChunks = responseEventToChatChunks(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_123",
          object: "response",
          created_at: 1700000000,
          model: "gpt-test",
          status: "completed",
          usage: {
            input_tokens: 2,
            output_tokens: 3,
            total_tokens: 5,
          },
        },
      }),
      streamState,
    )

    expect(completedChunks.at(-1)).toBe("[DONE]")
    expect(completedChunks[0]).toMatchObject({
      choices: [
        {
          delta: {
            content: null,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5,
      },
    })
  })

  test("skips malformed stream events instead of throwing", () => {
    const streamState: ResponsesStreamState = {
      id: "resp_123",
      model: "gpt-test",
      created: 1700000000,
      roleSent: true,
    }

    expect(responseEventToChatChunks("not json {", streamState)).toEqual([])
    expect(responseEventToChatChunks("[DONE]", streamState)).toEqual([])
    expect(responseEventToChatChunks("", streamState)).toEqual([])

    // Stream state must be untouched so later valid events still work
    const deltaChunks = responseEventToChatChunks(
      JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }),
      streamState,
    )
    expect(deltaChunks).toHaveLength(1)
  })

  test("ignores unknown event types", () => {
    const streamState: ResponsesStreamState = {
      id: "resp_123",
      model: "gpt-test",
      created: 1700000000,
      roleSent: false,
    }

    expect(
      responseEventToChatChunks(
        JSON.stringify({ type: "response.output_item.added" }),
        streamState,
      ),
    ).toEqual([])
    expect(streamState.roleSent).toBe(false)
  })
})
