const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');

const PORT = process.env.PORT || 8080;

const SUPABASE_URL = 'https://cqvjimjjmeiwyrxhtlzp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxdmppbWpqbWVpd3lyeGh0bHpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3Mzc5MzcsImV4cCI6MjA5NTMxMzkzN30.Sm74a0vo5E9emH-fx1mxc0f17q1pRayRaFM0_TX4nW0';
const EVOLUTION_URL = 'https://evolution-api-production-b358.up.railway.app';
const EVOLUTION_KEY = '0031e900630b589d7fd542acbfb6c9818063014312db4944a726b600afe98145';
const EVOLUTION_INSTANCE = 'aftermoonagency';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Horário/fuso padrão para clientes sem configuração própria em `ground_control`
const HORARIO_PADRAO = '08:08';
const TIMEZONE_PADRAO = 'America/Sao_Paulo';

// Retorna a data (YYYY-MM-DD) e a hora (HH:MM) "agora" no fuso informado,
// usando o Intl nativo do Node — sem precisar de nenhuma lib nova.
function agoraNoFuso(timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const partes = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { data: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

// Confirma entrega real da mensagem via Evolution API (DELIVERY_ACK/READ)
// antes de marcar como "Enviado" — regra pedida depois do incidente de RLS.
async function confirmarEntrega(messageId, tentativas = 4, intervaloMs = 5000) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, intervaloMs));
    try {
      const { data } = await axios.post(
        `${EVOLUTION_URL}/chat/findMessages/${EVOLUTION_INSTANCE}`,
        { where: { key: { id: messageId } } },
        { headers: { apikey: EVOLUTION_KEY } }
      );
      const status = data?.[0]?.MessageUpdate?.slice(-1)?.[0]?.status
        || data?.[0]?.status;
      if (status === 'DELIVERY_ACK' || status === 'READ') return true;
    } catch (e) { /* tenta de novo na próxima volta */ }
  }
  return false;
}

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
  console.log('[GROUND CONTROL] Verificando agenda no Supabase...');

  const { data: itens, error } = await supabase
    .from('ground_control_conteudo')
    .select('*, clientes(nome, telefone)')
    .eq('status', 'Agendado');
  if (error) { console.error('[GROUND CONTROL] Erro Supabase:', error); return; }
  if (!itens?.length) { console.log('[GROUND CONTROL] Nada agendado no momento.'); return; }

  // horários próprios por cliente (cache de uma leitura só)
  const { data: configs } = await supabase.from('ground_control').select('cliente_id, horario_envio, timezone, horario_proprio');
  const configPorCliente = Object.fromEntries((configs || []).map(c => [c.cliente_id, c]));

  for (const item of itens) {
    const cliente = item.clientes;
    if (!cliente) { console.log(`[GROUND CONTROL] ❌ Item ${item.id} sem cliente vinculado.`); continue; }

    const config = configPorCliente[item.cliente_id];
    const timezone = (config?.horario_proprio && config.timezone) ? config.timezone : TIMEZONE_PADRAO;
    const horarioAlvo = (config?.horario_proprio && config.horario_envio) ? config.horario_envio.slice(0, 5) : HORARIO_PADRAO;

    const { data: dataLocal, hora: horaLocal } = agoraNoFuso(timezone);
    if (item.data !== dataLocal) continue;       // ainda não é o dia local do cliente
    if (horaLocal < horarioAlvo) continue;        // ainda não bateu o horário configurado

    // trava otimista pra não disparar 2x se o cron rodar de novo antes de terminar
    const { error: lockError } = await supabase
      .from('ground_control_conteudo')
      .update({ status: 'Enviando' })
      .eq('id', item.id)
      .eq('status', 'Agendado');
    if (lockError) continue;

    const primeiroNome = cliente.nome.split(' ')[0];
    const mensagem = `Bom dia, ${primeiroNome}! \n\n🎥 Hoje é dia de gravar: *"${item.tema}"*${item.territorio ? ` — Território: ${item.territorio}` : ''}.\n\n${item.instrucao || ''}\n\n📲 Postar onde? *${item.tipo}*\n\nQualquer dúvida, me chama! 🚀`;

    try {
      const resp = await axios.post(
        `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
        { number: cliente.telefone, text: mensagem },
        { headers: { apikey: EVOLUTION_KEY } }
      );
      const messageId = resp.data?.key?.id;
      const entregue = messageId ? await confirmarEntrega(messageId) : false;

      await supabase.from('ground_control_conteudo')
        .update({ status: entregue ? 'Enviado' : 'Falhou', enviado_em: new Date().toISOString() })
        .eq('id', item.id);

      if (entregue) {
        await supabase.from('ground_control_log').insert({ cliente_nome: cliente.nome, tipo: item.tipo, tema: item.tema, telefone: cliente.telefone });
        console.log(`[GROUND CONTROL] ✅ Enviado e confirmado para ${cliente.nome} — ${item.tipo}: ${item.tema}`);
      } else {
        console.log(`[GROUND CONTROL] ⚠️ Enviado mas sem confirmação de entrega para ${cliente.nome} — marcado como Falhou, será revisado manualmente.`);
      }
    } catch (err) {
      await supabase.from('ground_control_conteudo').update({ status: 'Falhou' }).eq('id', item.id);
      console.error(`[GROUND CONTROL] ❌ Erro para ${cliente.nome}:`, err.message);
    }
  }
}

// Cobranças: todo dia às 08:08 horário de Brasília = 11:08 UTC
cron.schedule('8 11 * * *', async () => {
  await enviarCobrancas();
});

// Ground Control: checa a cada 5 minutos, pra respeitar o horário
// configurado individualmente por cliente (fusos diferentes)
cron.schedule('*/5 * * * *', async () => {
  await enviarGroundControl();
});

console.log('🚀 Aftermoon Orbit + Ground Control rodando...');
console.log('⏰ Cobranças: 08:08 (horário de Brasília). Ground Control: checagem a cada 5 min, por horário configurado por cliente.');
