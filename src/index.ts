import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  TextBlock,
  ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, type Config as ConfigT } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }
}

export const name = 'image-describer-tool'

/**
 * Required services. Cordis ensures `tools`, `llm` and `attachments`
 * are ready before invoking `apply`.
 */
export const inject = ['tools', 'llm', 'attachments'] as const

const EXT_TO_MEDIA_TYPE: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function detectMediaType(filePath: string): ImageMediaType {
  const ext = path.extname(filePath).toLowerCase()
  const mediaType = EXT_TO_MEDIA_TYPE[ext]
  if (!mediaType) {
    throw new Error(
      `Unsupported image format "${ext}" for "${filePath}". Supported formats: PNG, JPEG, WebP, GIF.`,
    )
  }
  return mediaType
}

/**
 * Helper to call the multimodal vision model for an image attachment.
 */
async function describeImageAttachment(
  ctx: Context,
  config: ConfigT,
  attachment: ImageAttachmentRef,
  prompt?: string,
  signal?: AbortSignal,
): Promise<string> {
  const effectivePrompt =
    prompt && prompt.trim().length > 0 ? prompt.trim() : config.prompt

  const userMessage: Message = {
    id: '__image_describer_aux__' as Message['id'],
    role: 'user',
    content: [
      { type: 'text', text: effectivePrompt },
      { type: 'image', attachment },
    ],
    source: { kind: 'plugin', plugin: 'image-describer-tool' },
  }

  let description = ''
  let finishedKind: string | undefined

  const stream = ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    messages: [userMessage],
    maxTokens: config.maxTokens,
    signal,
  }) as AsyncIterable<StreamChunk>

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        description += chunk.text
        break
      case 'finish':
        finishedKind = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new Error(
            `Vision model (${config.provider}/${config.model}) failed: ${
              chunk.reason.failure?.message ?? chunk.reason.kind
            }`,
          )
        }
        break
    }
  }

  if (finishedKind === undefined) {
    throw new Error('Vision model stream ended unexpectedly without a finish chunk')
  }

  description = description.trim()
  if (description.length === 0) {
    throw new Error('Vision model returned an empty description')
  }

  return description
}

/**
 * Rewrites messages containing raw ImageBlocks into contextual TextBlocks.
 */
async function rewriteMessages(
  ctx: Context,
  config: ConfigT,
  messages: readonly Message[],
  signal?: AbortSignal,
): Promise<Message[]> {
  const result: Message[] = []

  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push(message)
      continue
    }

    let hasImage = false
    for (const block of message.content) {
      if (block.type === 'image') {
        hasImage = true
        break
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        if (block.content.some((inner) => inner.type === 'image')) {
          hasImage = true
          break
        }
      }
    }

    if (!hasImage) {
      result.push(message)
      continue
    }

    const newContent: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'image') {
        const desc = await describeImageAttachment(
          ctx,
          config,
          block.attachment,
          undefined,
          signal,
        )
        const imageName = block.attachment.name ?? '未命名图片'
        const textBlock: TextBlock = {
          type: 'text',
          text: `\n\n[系统提示：用户在聊天中直接上传/粘贴了图片（非本地工作区文件，已由视觉模型 ${config.model} 完整识别解析）。请直接基于以下识别结果回答用户的问题，无需在本地文件系统中搜索该图片或再次调用工具：\n${desc}\n]\n\n`,
        }
        newContent.push(textBlock)
      } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const innerContent: ContentBlock[] = []
        for (const inner of block.content) {
          if (inner.type === 'image') {
            const desc = await describeImageAttachment(
              ctx,
              config,
              inner.attachment,
              undefined,
              signal,
            )
            innerContent.push({
              type: 'text',
              text: `\n\n[图片识别结果（已由视觉模型 ${config.model} 完整识别解析，请直接基于此内容回答）：\n${desc}\n]\n\n`,
            })
          } else {
            innerContent.push(inner)
          }
        }
        const toolResultBlock: ToolResultBlock = {
          ...block,
          content: innerContent,
        }
        newContent.push(toolResultBlock)
      } else {
        newContent.push(block)
      }
    }

    result.push({
      ...message,
      content: newContent,
    })
  }

  return result
}

const toolParameters = {
  filePath: {
    type: 'string',
    required: true,
    description:
      'The path to the image file (e.g. "screenshot.png", "assets/diagram.jpg"). Can be absolute or relative to the workspace.',
  },
  prompt: {
    type: 'string',
    description:
      'Specific question or focus for the visual analysis (e.g. "Transcribe the error message", "Describe the UI layout", "What numbers are in the chart?"). If omitted, a comprehensive Chinese description will be generated.',
  },
} as const

const toolOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    filePath: {
      type: 'string',
      required: true,
    },
    description: {
      type: 'string',
      required: true,
    },
  },
} as const

export function apply(ctx: Context, config: ConfigT): void {
  ctx.logger.info(
    `[image-describer-tool] plugin loaded; provider=${config.provider}, model=${config.model}`,
  )

  const NS = settingsNamespace('image-describer')
  let getConfig = () => config

  try {
    installSettingsSection(ctx, NS, Config, config, {
      setSource(current) {
        getConfig = current
      },
      onChange() {},
    })
  } catch (error) {
    ctx.logger.warn(
      `image-describer-tool: settings section unavailable (${(error as Error).message})`,
    )
  }

  // 1. Register the explicit describe_image tool (for model active tool invocation)
  ctx.tools.register(
    defineTool({
      name: 'describe_image',
      description:
        'Inspect, analyze, and describe a local image file using a multimodal vision model. Call this tool whenever you need to see, inspect, read text (OCR), analyze charts/diagrams, or answer questions about an image in the workspace.',
      parameters: toolParameters,
      output: {
        schema: toolOutputSchema,
        render: (_args, value) => [
          {
            type: 'text',
            text: value.description,
          },
        ],
      },
      timeoutMs: config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const liveConfig = getConfig()
        const resolvedPath = path.isAbsolute(args.filePath)
          ? args.filePath
          : path.resolve(process.cwd(), args.filePath)

        let bytes: Buffer
        try {
          bytes = await fs.readFile(resolvedPath)
        } catch (err) {
          throw new Error(`Failed to read image file "${args.filePath}": ${(err as Error).message}`)
        }

        const mediaType = detectMediaType(resolvedPath)
        const attachment = await ctx.attachments.saveImage({
          data: new Uint8Array(bytes),
          mediaType,
          name: path.basename(resolvedPath),
        })

        const description = await describeImageAttachment(
          ctx,
          liveConfig,
          attachment,
          args.prompt,
          exec.signal,
        )

        return {
          filePath: resolvedPath,
          description,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Describe image ${path.basename(args.filePath)}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  // 2. Register llm/stream listener for direct UI paste handling
  ctx.on(
    'llm/stream',
    async function* wrapStream(options, next) {
      const liveConfig = getConfig()

      // Guard 1: if target model is the describer model itself, pass through
      if (options.provider === liveConfig.provider && options.model === liveConfig.model) {
        yield* next()
        return
      }

      // Guard 2: if message is our internal auxiliary request, pass through
      if (
        options.messages.some(
          (m) => m.id === ('__image_describer_aux__' as Message['id']),
        )
      ) {
        yield* next()
        return
      }

      // Check if any message contains an image
      const hasImages = options.messages.some((m) => {
        if (typeof m.content === 'string') return false
        return m.content.some((b) => {
          if (b.type === 'image') return true
          if (b.type === 'tool-result' && Array.isArray(b.content)) {
            return b.content.some((inner) => inner.type === 'image')
          }
          return false
        })
      })

      if (!hasImages) {
        yield* next()
        return
      }

      // Rewrite images to explicitly tagged text descriptions
      const newMessages = await rewriteMessages(
        ctx,
        liveConfig,
        options.messages,
        options.signal,
      )

      ctx.logger.info(
        `[image-describer-tool] Converted UI pasted image(s) to contextual descriptions for ${options.provider}/${options.model}`,
      )

      const newOptions: GenerateOptions = {
        ...options,
        messages: newMessages,
      }
      yield* ctx.llm.stream(newOptions)
    },
    { global: true },
  )
}