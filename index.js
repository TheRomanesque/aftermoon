const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');

const SUPABASE_URL = 'https://cqvjimjjmeiwyrxhtlzp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxdmppbWpqbWVpd3lyeGh0bHpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3Mzc5MzcsImV4cCI6MjA5NTMxMzkzN30.Sm74a0vo5E9emH-fx1mxc0f17q1pRayRaFM0_TX4nW0';
const EVOLUTION_URL = 'https://evolution-api-production-b358.up.railway.app';
const EVOLUTION_KEY = '0031e900630b589d7fd542acbfb6c9818063014312db4944a726b600afe98145';
const EVOLUTION_INSTANCE = 'Afternoon Agency';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function enviarCobrancas() {
  const hoje = new Date().toISOString().split('T')[0];
  console.log(`Verificando parcelas para ${hoje}...`);

  const { data: parcelas, error } = await supabase
    .from('parcelas')
    .select('*, cobrancas(job, valor_total, total_parcelas, clientes(nome, telefone))')
    .eq('data_vencimento', hoje)
    .eq('enviada', false);

  if (error) { console.error('Erro Supabase:', error); return; }
  if (!parcelas.length) { console.log('Nenhuma parcela para hoje.'); return; }

  for (const parcela of parcelas) {
    const cliente = parcela.cobrancas.clientes;
    const cobranca = parcela.cobrancas;
    const mensagem = `Olá, ${cliente.nome}! 👋\n\nPassando para lembrar que a parcela *${parcela.numero} de ${cobranca.total_parcelas}* do job *${cobranca.job}* vence hoje.\n\n💰 Valor: *R$ ${parcela.valor.toLocaleString('pt-BR', {minimumFractionDigits:2})}*\n\nQualquer dúvida, estou à disposição. Obrigado! 🙏`;

    try {
      await axios.post(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
        number: cliente.telefone,
        text: mensagem
      }, {
        headers: { apikey: EVOLUTION_KEY }
      });

      await supabase.from('parcelas').update({ enviada: true }).eq('id', parcela.id);
      console.log(`✅ Mensagem enviada para ${cliente.nome}`);
    } catch (err) {
      console.error(`❌ Erro ao enviar para ${cliente.nome}:`, err.message);
    }
  }
}

cron.schedule('0 9 * * *', enviarCobrancas);
console.log('🚀 Sistema de cobranças rodando...');
enviarCobrancas();
