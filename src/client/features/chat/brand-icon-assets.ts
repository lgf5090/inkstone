/**
 * The SVG files the brand picker draws, emitted as URLs rather than inlined.
 *
 * The files are vendored in `src/client/assets/brands` from `@lobehub/icons-static-svg` (MIT); the
 * README beside them records the source. A brand with no file here is drawn as its monogram, so adding a
 * vendor to the catalogue never requires an asset to exist first.
 */
import alibaba from '../../assets/brands/alibaba.svg?url'
import anthropic from '../../assets/brands/anthropic.svg?url'
import aws from '../../assets/brands/aws.svg?url'
import azure from '../../assets/brands/azure.svg?url'
import baichuan from '../../assets/brands/baichuan.svg?url'
import baidu from '../../assets/brands/baidu.svg?url'
import bytedance from '../../assets/brands/bytedance.svg?url'
import cerebras from '../../assets/brands/cerebras.svg?url'
import cohere from '../../assets/brands/cohere.svg?url'
import deepinfra from '../../assets/brands/deepinfra.svg?url'
import deepseek from '../../assets/brands/deepseek.svg?url'
import fireworks from '../../assets/brands/fireworks.svg?url'
import gemini from '../../assets/brands/gemini.svg?url'
import gemma from '../../assets/brands/gemma.svg?url'
import googlecloud from '../../assets/brands/googlecloud.svg?url'
import groq from '../../assets/brands/groq.svg?url'
import huggingface from '../../assets/brands/huggingface.svg?url'
import hunyuan from '../../assets/brands/hunyuan.svg?url'
import internlm from '../../assets/brands/internlm.svg?url'
import kimi from '../../assets/brands/kimi.svg?url'
import meta from '../../assets/brands/meta.svg?url'
import microsoft from '../../assets/brands/microsoft.svg?url'
import minimax from '../../assets/brands/minimax.svg?url'
import mistral from '../../assets/brands/mistral.svg?url'
import modelscope from '../../assets/brands/modelscope.svg?url'
import nvidia from '../../assets/brands/nvidia.svg?url'
import ollama from '../../assets/brands/ollama.svg?url'
import openai from '../../assets/brands/openai.svg?url'
import openrouter from '../../assets/brands/openrouter.svg?url'
import perplexity from '../../assets/brands/perplexity.svg?url'
import qwen from '../../assets/brands/qwen.svg?url'
import siliconflow from '../../assets/brands/siliconflow.svg?url'
import stepfun from '../../assets/brands/stepfun.svg?url'
import tencent from '../../assets/brands/tencent.svg?url'
import together from '../../assets/brands/together.svg?url'
import upstage from '../../assets/brands/upstage.svg?url'
import volcengine from '../../assets/brands/volcengine.svg?url'
import xai from '../../assets/brands/xai.svg?url'
import yi from '../../assets/brands/yi.svg?url'
import zhipu from '../../assets/brands/zhipu.svg?url'

export const BRAND_ICON_URLS: Readonly<Record<string, string>> = {
  alibaba,
  anthropic,
  aws,
  azure,
  baichuan,
  baidu,
  bytedance,
  cerebras,
  cohere,
  deepinfra,
  deepseek,
  fireworks,
  gemini,
  gemma,
  googlecloud,
  groq,
  huggingface,
  hunyuan,
  internlm,
  kimi,
  meta,
  microsoft,
  minimax,
  mistral,
  modelscope,
  nvidia,
  ollama,
  openai,
  openrouter,
  perplexity,
  qwen,
  siliconflow,
  stepfun,
  tencent,
  together,
  upstage,
  volcengine,
  xai,
  yi,
  zhipu,
}
