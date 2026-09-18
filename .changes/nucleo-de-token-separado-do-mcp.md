---
impacto: nada_mudou
secao: alterado
titulo: Arrumação interna de quem valida as chaves de integração
---

A parte do sistema que confere uma chave de integração (as que começam com `dsk_`) foi separada em duas: a que decide se a chave vale, e a que traduz a recusa para o formato de quem perguntou. Antes as duas eram a mesma peça, e qualquer outro pedaço do sistema que quisesse conferir uma chave tinha de carregar junto o vocabulário de erro de um protocolo que não era o dele.

Nada muda para quem usa ou opera o sistema: as mesmas chaves continuam valendo, as recusas (chave desconhecida, revogada ou vencida) continuam devolvendo exatamente a mesma resposta, e o registro de último uso da chave continua sendo gravado. Você não precisa fazer nada e nenhuma integração precisa ser refeita.

Crédito: @faxamkt.
