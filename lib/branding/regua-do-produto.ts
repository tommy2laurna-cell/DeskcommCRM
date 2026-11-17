/**
 * A régua do design system, congelada em módulo — a fonte da derivação em RUNTIME.
 *
 * POR QUE ESTE ARQUIVO EXISTE, e não um `readFileSync("app/globals.css")`:
 *
 * A imagem de produção é `output: "standalone"` (next.config.ts) e o Dockerfile
 * copia para o runner apenas `.next/standalone`, `.next/static` e `public/`. O
 * `app/globals.css` NÃO existe no contêiner que o self-hoster roda. Um
 * `readFileSync` no caminho de render do `app/layout.tsx` daria ENOENT — 500 em
 * todas as telas, na VPS de quem a feature existe para servir, e verde em dev,
 * em teste e na Vercel. É o mesmo modo de falha que `lib/branding.ts` documenta
 * para o `NEXT_PUBLIC_*`.
 *
 * A separação também é a certa conceitualmente: a RÉGUA é do produto e nasce
 * congelada no build; a COR é da instalação e só existe em runtime. Só a segunda
 * precisa ser lida do ambiente.
 *
 * ESTE ARQUIVO É GERADO. Não edite à mão: ele é o `extrairRegua()` aplicado ao
 * `app/globals.css`. `tests/unit/branding-regua-do-produto.test.ts` compara os
 * dois a cada run e imprime o literal novo na mensagem de falha — mexeu na
 * paleta, o teste reprova e entrega o texto para colar aqui.
 */

import type { Regua } from "./contraste";

export const REGUA_DO_PRODUTO: Regua = {
  "rampaDoProduto": [
    "#f3f6f1",
    "#e4ebe0",
    "#c8d6c1",
    "#a4ba9a",
    "#82a077",
    "#67885d",
    "#506d48",
    "#41573b",
    "#374731",
    "#2f3c2b",
    "#171f15"
  ],
  "claro": {
    "nome": "claro",
    "base": [
      {
        "chave": "--color-bg",
        "hex": "#eef0f4"
      },
      {
        "chave": "--color-surface",
        "hex": "#f7f8fa"
      },
      {
        "chave": "--color-surface-elevated",
        "hex": "#ffffff"
      }
    ],
    "tingidas": [
      {
        "chave": "--color-accent-soft",
        "fonte": {
          "tipo": "grau",
          "indice": 1,
          "alfa": 1
        }
      }
    ],
    "papeis": [
      {
        "token": "--color-accent",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 6,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-fg",
        "tipo": "texto",
        "fonte": {
          "tipo": "frenteCalculada",
          "sobre": {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 6,
            "alfa": 1
          }
        ]
      },
      {
        "token": "--color-accent-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 7,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--ring",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 5,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "::selection/color",
        "tipo": "texto",
        "fonte": {
          "tipo": "grau",
          "indice": 10,
          "alfa": 1
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 2,
            "alfa": 1
          }
        ]
      },
      {
        "token": ":focus-visible/outline",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 5,
          "alfa": 1
        },
        "contra": null
      }
    ],
    "semanticas": [
      {
        "nome": "success",
        "hex": "#146c34"
      },
      {
        "nome": "warning",
        "hex": "#92600a"
      },
      {
        "nome": "error",
        "hex": "#b42318"
      },
      {
        "nome": "info",
        "hex": "#3f5f9e"
      }
    ],
    "neutros": [
      "#f7f8fa",
      "#eef0f4",
      "#e1e3ea",
      "#cdd0da",
      "#9a9dab",
      "#70737f",
      "#52545f",
      "#3a3a45",
      "#22232b",
      "#0e0e12",
      "#07070a"
    ],
    "indices": {
      "accent": 6,
      "hover": 7,
      "soft": 1
    },
    "alfaDoSoft": 1
  },
  "escuro": {
    "nome": "escuro",
    "base": [
      {
        "chave": "--color-bg",
        "hex": "#0a0a0b"
      },
      {
        "chave": "--color-surface",
        "hex": "#121216"
      },
      {
        "chave": "--color-surface-elevated",
        "hex": "#1a1a20"
      }
    ],
    "tingidas": [
      {
        "chave": "--color-accent-soft",
        "fonte": {
          "tipo": "literal",
          "hex": "#82a077",
          "alfa": 0.16
        }
      }
    ],
    "papeis": [
      {
        "token": "--color-accent",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 4,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--color-accent-fg",
        "tipo": "texto",
        "fonte": {
          "tipo": "frenteCalculada",
          "sobre": {
            "tipo": "grau",
            "indice": 4,
            "alfa": 1
          }
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 4,
            "alfa": 1
          }
        ]
      },
      {
        "token": "--color-accent-hover",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 3,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "--ring",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 4,
          "alfa": 1
        },
        "contra": null
      },
      {
        "token": "[data-theme=\"dark\"] ::selection/color",
        "tipo": "texto",
        "fonte": {
          "tipo": "grau",
          "indice": 0,
          "alfa": 1
        },
        "contra": [
          {
            "tipo": "grau",
            "indice": 7,
            "alfa": 1
          }
        ]
      },
      {
        "token": "[data-theme=\"dark\"] :focus-visible/outline-color",
        "tipo": "componente",
        "fonte": {
          "tipo": "grau",
          "indice": 4,
          "alfa": 1
        },
        "contra": null
      }
    ],
    "semanticas": [
      {
        "nome": "success",
        "hex": "#4ade80"
      },
      {
        "nome": "warning",
        "hex": "#fbbf24"
      },
      {
        "nome": "error",
        "hex": "#f87171"
      },
      {
        "nome": "info",
        "hex": "#8aa4d6"
      }
    ],
    "neutros": [
      "#f5f5f7",
      "#e4e4e9",
      "#c9c9d1",
      "#8e8e99",
      "#5f5f6b",
      "#43434d",
      "#2e2e36",
      "#22222a",
      "#1a1a20",
      "#121216",
      "#0a0a0b"
    ],
    "indices": {
      "accent": 4,
      "hover": 3,
      "soft": null
    },
    "alfaDoSoft": 0.16
  }
} as const;
