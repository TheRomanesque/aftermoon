const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');
const { Client } = require('@notionhq/client');

const PORT = process.env.PORT || 8080;

const SUPABASE_URL = 'https://cqvjimjjmeiwyrxhtlzp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxdmppbWpqbWVpd3lyeGh0bHpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3Mzc5MzcsImV4cCI6MjA5NTMxMzkzN30.Sm74a0vo5E9emH-fx1mxc0f17q1pRayRaFM0_TX4nW0';
const EVOLUTION_URL = 'https://evolution-api-production-b358.up.railway.app';
const EVOLUTION_KEY = '0031e900630b589d7fd542acbfb6c9818063014312db4944a726b600afe98145';
const EVOLUTION_INSTANCE = 'afternoonagency';
const NOTION_TOKEN = 'ntn_J223093786127UCm1ZN1c2VwnNgWB1szb0pMQ3qRoPBdpT';
const NOTION_DB_ID = '6e16239725d64cda85cfc23cdcb37595';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const notion = new Client({ auth: NOTION_TOKEN });

http.createServer((req, res) => {
  const file = path.join(__dirname, 'painel-cobrancas.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('Erro: ' + err.message); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, () => console.log('🌐 Servidor rodando na porta ' + PORT));

async function enviarCobrancas() {
  const hoje = new Date().toISOString().split('T')[0];
  console.log(`[COBRANÇAS] Verificando parcelas para ${hoje}...`);
  const { data: parcelas, error } = await supabase
    .from('parcelas')
    .select('*, cobrancas(job, valor_total, total_parcelas, clientes(nome, telefone))')
    .eq('data_vencimento', hoje)
    .eq('enviada', false)
    .eq('quitado', false);
  if (error) { console.error('Erro Supabase:', error); return; }
  if (!parcelas.length) { console.log('[COBRANÇAS] Nenhuma parcela para hoje.'); return; }
  for (const parcela of parcelas) {
    const cliente = parcela.cobrancas.clientes;
    const cobranca = parcela.cobrancas;
    const mensagem = `Olá, ${cliente.nome}! 👋\n\nPassando para lembrar que a parcela *${parcela.numero} de ${cobranca.total_parcelas}* do job *${cobranca.job}* vence hoje.\n\n💰 Valor: *R$ ${parcela.valor.toLocaleString('pt-BR', {minimumFractionDigits:2})}*\n\nQualquer dúvida, estou à disposição. Obrigado! 🙏`;
    try {
      await axios.post(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, { number: cliente.telefone, text: mensagem }, { headers: { apikey: EVOLUTION_KEY } });
      await supabase.from('parcelas').update({ enviada: true }).eq('id', parcela.id);
      console.log(`[COBRANÇAS] ✅ Enviado para ${cliente.nome}`);
    } catch (err) {
      console.error(`[COBRANÇAS] ❌ Erro para ${cliente.nome}:`, err.message);
    }
  }
}

async function enviarGroundControl() {
  const hoje = new Date().toISOString().split('T')[0];
  console.log(`[GROUND CONTROL] Verificando conteúdos para ${hoje}...`);
  try {
    const response = await notion.databases.query({
      database_id: NOTION_DB_ID,
      filter: { property: 'Data', date: { equals: hoje } }
    });
    if (!response.results.length) { console.log('[GROUND CONTROL] Nenhum conteúdo para hoje.'); return; }
    for (const page of response.results) {
      const props = page.properties;
      const statusAtual = props.Status?.select?.name || props.Status?.status?.name || '';
      if (statusAtual === 'Enviado') { continue; }
      const clienteNome = props.Cliente?.rich_text?.[0]?.plain_text || '';
      const tipo = props.Tipo?.select?.name || '';
      const tema = props.Tema?.title?.[0]?.plain_text || '';
      const instrucao = props.Instrução?.rich_text?.[0]?.plain_text || '';
      const territorio = props.Território?.rich_text?.[0]?.plain_text || '';
      if (!clienteNome) { continue; }
      const { data: clientes } = await supabase.from('clientes').select('nome, telefone').ilike('nome', `%${clienteNome}%`).limit(1);
      if (!clientes?.length) { console.log(`[GROUND CONTROL] ❌ "${clienteNome}" não encontrado.`); continue; }
      const cliente = clientes[0];

      const primeiroNome = cliente.nome.split(' ')[0];
      const mensagem = `Bom dia, ${primeiroNome}! \n\n🎥 Hoje é dia de gravar: *"${tema}"*${territorio ? ` — Território: ${territorio}` : ''}.\n\n${instrucao}\n\n📲 Postar onde? *${tipo}*\n\nQualquer dúvida, me chama! 🚀`;

      try {
        await axios.post(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, { number: cliente.telefone, text: mensagem }, { headers: { apikey: EVOLUTION_KEY } });
        try { await notion.pages.update({ page_id: page.id, properties: { Status: { select: { name: 'Enviado' } } } }); } catch(e) {}
        await supabase.from('ground_control_log').insert({ cliente_nome: cliente.nome, tipo, tema, telefone: cliente.telefone });
        console.log(`[GROUND CONTROL] ✅ Enviado para ${cliente.nome} — ${tipo}: ${tema}`);
      } catch (err) {
        console.error(`[GROUND CONTROL] ❌ Erro para ${cliente.nome}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[GROUND CONTROL] Erro ao consultar Notion:', err.message);
  }
}

// 08:08 horário de Brasília = 11:08 UTC
cron.schedule('8 11 * * *', async () => {
  await enviarCobrancas();
  await enviarGroundControl();
});

console.log('🚀 Aftermoon Orbit + Ground Control rodando...');
console.log('⏰ Disparos agendados para 08:08 (horário de Brasília).');
