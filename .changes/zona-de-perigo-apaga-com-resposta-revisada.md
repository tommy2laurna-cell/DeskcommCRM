---
impacto: nada_mudou
secao: corrigido
titulo: A Zona de perigo volta a apagar os dados operacionais em quem já enviou resposta revisada
---
Numa organização com resposta revisada, "apagar dados operacionais" parava na primeira tabela: a chave estrangeira de `ai_reply_drafts.message_id` apontava para `messages` sem ação de exclusão, então o banco recusava o `delete from messages` antes de a exclusão das conversas levar os rascunhos junto. O botão prometia apagar seis tabelas e não apagava nenhuma.

A chave passa a `on delete set null`, como as outras três que apontam para `messages`. Na Zona de perigo o rascunho continua indo embora com a conversa, que é o dado operacional da organização; o que a ação muda é o caminho inverso — apagar uma mensagem avulsa deixa de travar (e deixa de arrastar o rascunho). Um invariante de banco novo cobre o caso: organização com resposta revisada apagada por inteiro, e a organização vizinha intacta.

Nada muda para quem opera: a correção é de banco e se aplica sozinha na atualização.
