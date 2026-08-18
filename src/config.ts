import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Provider route that owns the multimodal vision model. */
  provider: string

  /** Vision model id. Must declare image input modality. */
  model: string

  /** Default prompt sent to the vision model if the model/user does not specify a specific prompt. */
  prompt: string

  /** Max output tokens per description. */
  maxTokens: number

  /** Tool timeout in milliseconds. */
  timeoutMs: number
}

export const Config = Schema.object({
  provider: Schema.string().default('minimax-cn').description('多模态视觉模型 Provider 路由（如 minimax-cn, opencode-go2 等）'),
  model: Schema.string().default('MiniMax-M3').description('多模态视觉模型 ID（如 MiniMax-M3, minimax-m3, gpt-4o 等）'),
  prompt: Schema.string().default(
    '请用中文详细描述这张图片。重点：1) 主体内容；2) 关键文字/数字（如有）；3) 任何图表、代码、错误信息请尽量转录；4) 与用户提问相关的事实细节。',
  ).description('默认分析提示词模板'),
  maxTokens: Schema.number().default(2048).description('单次分析输出最大 Token 数量'),
  timeoutMs: Schema.number().default(60000).description('单次分析超时时间（毫秒）'),
})