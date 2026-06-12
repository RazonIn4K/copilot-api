import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "./create-chat-completions"

export const createResponsesFromChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(toResponsesPayload(payload)),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create response", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponseApiResponse
}

export const shouldUseResponsesEndpoint = (endpoints?: Array<string>) =>
  endpoints ?
    endpoints.includes("/responses") && !endpoints.includes("/chat/completions")
  : false

export function responseToChatCompletion(
  response: ResponseApiResponse,
): ChatCompletionResponse {
  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: getResponseText(response),
        },
        logprobs: null,
        finish_reason: response.status === "completed" ? "stop" : "length",
      },
    ],
    usage: toChatUsage(response.usage),
  }
}

export function responseEventToChatChunks(
  eventData: string,
  state: ResponsesStreamState,
): Array<ChatCompletionChunk | "[DONE]"> {
  const event = JSON.parse(eventData) as ResponseStreamEvent

  if (event.type === "response.created" && event.response) {
    state.id = event.response.id
    state.model = event.response.model
    state.created = event.response.created_at
    return []
  }

  if (event.type === "response.output_text.delta" && event.delta) {
    const role = state.roleSent ? undefined : "assistant"
    state.roleSent = true

    return [
      {
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {
              role,
              content: event.delta,
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
    ]
  }

  if (event.type === "response.completed" && event.response) {
    state.id = event.response.id
    state.model = event.response.model
    state.created = event.response.created_at
    state.roleSent = true

    return [
      {
        id: event.response.id,
        object: "chat.completion.chunk",
        created: event.response.created_at,
        model: event.response.model,
        choices: [
          {
            index: 0,
            delta: {
              content: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: toChatUsage(event.response.usage),
      },
      "[DONE]",
    ]
  }

  return []
}

export interface ResponsesStreamState {
  created: number
  id: string
  model: string
  roleSent: boolean
}

interface ResponsesPayload {
  input: Array<ResponseInputMessage>
  max_output_tokens?: number | null
  model: string
  stream?: boolean | null
  temperature?: number | null
  top_p?: number | null
}

interface ResponseInputMessage {
  content: string
  role: "assistant" | "developer" | "system" | "user"
}

export interface ResponseApiResponse {
  created_at: number
  error?: unknown
  id: string
  model: string
  object: "response"
  output?: Array<ResponseOutputItem>
  status: string
  usage?: ResponseUsage | null
}

interface ResponseOutputItem {
  content?: Array<ResponseContentPart>
}

interface ResponseContentPart {
  text?: string
  type: string
}

interface ResponseUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

interface ResponseStreamEvent {
  delta?: string
  response?: ResponseApiResponse
  type: string
}

function toResponsesPayload(payload: ChatCompletionsPayload): ResponsesPayload {
  return {
    model: payload.model,
    input: payload.messages.flatMap((message) =>
      toResponseInputMessage(message),
    ),
    max_output_tokens: payload.max_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
  }
}

function toResponseInputMessage(message: Message): Array<ResponseInputMessage> {
  if (message.role === "tool") {
    return [
      {
        role: "user",
        content: contentToText(message.content),
      },
    ]
  }

  return [
    {
      role: message.role,
      content: contentToText(message.content),
    },
  ]
}

function contentToText(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!content) return ""

  return content.map((part) => contentPartToText(part)).join("\n")
}

function contentPartToText(part: ContentPart): string {
  if (part.type === "text") return part.text

  return `[image: ${part.image_url.url}]`
}

function getResponseText(response: ResponseApiResponse): string {
  return (
    response.output
      ?.flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("") ?? ""
  )
}

function toChatUsage(usage?: ResponseUsage | null) {
  if (!usage) return undefined

  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  }
}
