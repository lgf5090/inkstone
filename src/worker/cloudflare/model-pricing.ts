/**
 * Cloudflare's published neuron rates, as the reference module ships them.
 *
 * Data rather than code: the table changes when Cloudflare reprices a model, and the estimates in
 * `pricing.ts` are only as honest as this file. Kept as a TypeScript module so the worker's project
 * includes it without a JSON-in-program exception.
 */
export const MODEL_PRICING = {
  "models": {
    "@cf/ibm-granite/granite-4.0-h-micro": {
      "input": 1.542,
      "output": 10.158
    },
    "@cf/meta/llama-3.2-1b-instruct": {
      "input": 2.457,
      "output": 18.252
    },
    "@cf/meta/llama-3.2-3b-instruct": {
      "input": 4.625,
      "output": 30.475
    },
    "@cf/meta/llama-3.1-8b-instruct-fp8-fast": {
      "input": 4.119,
      "output": 34.868
    },
    "@cf/meta/llama-3.2-11b-vision-instruct": {
      "input": 4.41,
      "output": 61.493
    },
    "@cf/meta/llama-3.1-8b-instruct": {
      "input": 25.608,
      "output": 75.147
    },
    "@cf/meta/llama-3.1-70b-instruct-fp8-fast": {
      "input": 26.668,
      "output": 204.805
    },
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
      "input": 26.668,
      "output": 204.805
    },
    "@cf/qwen/qwen2.5-coder-32b-instruct": {
      "input": 60.0,
      "output": 90.909
    },
    "@cf/qwen/qwen3-30b-a3b-fp8": {
      "input": 4.625,
      "output": 30.475
    },
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
      "input": 45.17,
      "output": 443.756
    },
    "@cf/mistral/mistral-small-3.1-24b-instruct": {
      "input": 31.876,
      "output": 50.488
    },
    "@cf/mistral/mistral-7b-instruct-v0.1": {
      "input": 10.0,
      "output": 17.3
    },
    "@cf/meta/llama-3.1-8b-instruct-fp8": {
      "input": 13.778,
      "output": 26.128
    },
    "@cf/meta/llama-3.1-8b-instruct-awq": {
      "input": 11.161,
      "output": 24.215
    },
    "@cf/meta/llama-3-8b-instruct": {
      "input": 25.608,
      "output": 75.147
    },
    "@cf/meta/llama-3-8b-instruct-awq": {
      "input": 11.161,
      "output": 24.215
    },
    "@cf/meta/llama-2-7b-chat-fp16": {
      "input": 50.505,
      "output": 606.061
    },
    "@cf/meta/llama-guard-3-8b": {
      "input": 44.003,
      "output": 2.73
    },
    "@cf/meta/llama-4-scout-17b-16e-instruct": {
      "input": 24.545,
      "output": 77.273
    },
    "@cf/google/gemma-3-12b-it": {
      "input": 31.371,
      "output": 50.56
    },
    "@cf/qwen/qwq-32b": {
      "input": 60.0,
      "output": 90.909
    },
    "@cf/openai/gpt-oss-120b": {
      "input": 31.818,
      "output": 68.182
    },
    "@cf/openai/gpt-oss-20b": {
      "input": 18.182,
      "output": 27.273
    },
    "@cf/aisingapore/gemma-sea-lion-v4-27b-it": {
      "input": 31.876,
      "output": 50.488
    },
    "@cf/zai-org/glm-4.7-flash": {
      "input": 5.5,
      "output": 36.4
    },
    "@cf/zai-org/glm-5.2": {
      "input": 127.273,
      "cachedInput": 23.636,
      "output": 400.0
    },
    "@cf/nvidia/nemotron-3-120b-a12b": {
      "input": 45.455,
      "output": 136.364
    },
    "@cf/moonshotai/kimi-k2.5": {
      "input": 54.545,
      "cachedInput": 9.091,
      "output": 272.727
    },
    "@cf/moonshotai/kimi-k2.6": {
      "input": 86.364,
      "cachedInput": 14.545,
      "output": 363.636
    },
    "@cf/moonshotai/kimi-k2.7-code": {
      "input": 86.364,
      "cachedInput": 17.273,
      "output": 363.636
    },
    "@cf/google/gemma-4-26b-a4b-it": {
      "input": 9.091,
      "output": 27.273
    },
    "@cf/baai/bge-small-en-v1.5": {
      "input": 1.841,
      "output": 0
    },
    "@cf/baai/bge-base-en-v1.5": {
      "input": 6.058,
      "output": 0
    },
    "@cf/baai/bge-large-en-v1.5": {
      "input": 18.582,
      "output": 0
    },
    "@cf/baai/bge-m3": {
      "input": 1.075,
      "output": 0
    },
    "@cf/pfnet/plamo-embedding-1b": {
      "input": 1.689,
      "output": 0
    },
    "@cf/qwen/qwen3-embedding-0.6b": {
      "input": 1.075,
      "output": 0
    },
    "@cf/huggingface/distilbert-sst-2-int8": {
      "input": 2.394,
      "output": 0
    },
    "@cf/baai/bge-reranker-base": {
      "input": 0.283,
      "output": 0
    },
    "@cf/meta/m2m100-1.2b": {
      "input": 31.05,
      "output": 31.05
    },
    "@cf/ai4bharat/indictrans2-en-indic-1B": {
      "input": 31.05,
      "output": 31.05
    },
    "@cf/black-forest-labs/flux-1-schnell": {
      "perImage": 1338
    },
    "@cf/stabilityai/stable-diffusion-xl-base-1.0": {
      "perImage": 1338
    },
    "@cf/stabilityai/stable-diffusion-xl-base-1.0-int8": {
      "perImage": 1338
    },
    "@cf/stabilityai/stable-diffusion-xl-turbo-1.0": {
      "perImage": 1338
    },
    "@cf/stabilityai/stable-diffusion-v1-5": {
      "perImage": 671
    },
    "@cf/stabilityai/stable-diffusion-v1-5-int8": {
      "perImage": 671
    },
    "@cf/bytedance/stable-diffusion-xl-lightning": {
      "perImage": 1338
    },
    "@cf/deepgram/aura-1": {
      "perKChar": 30
    },
    "@cf/deepgram/aura-2-en": {
      "perKChar": 30
    },
    "@cf/deepgram/aura-2-es": {
      "perKChar": 30
    }
  },
  "default": {
    "input": 30,
    "output": 60
  },
  "defaultImage": {
    "perImage": 1338
  },
  "defaultTts": {
    "perKChar": 30
  }
} as const
