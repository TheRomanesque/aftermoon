const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');

const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/api/launchpad/linkedin/connect') {
    return iniciarConexaoLinkedIn(req, res, url);
  }
  if (url.pathname === '/api/launchpad/linkedin/callback') {
    return finalizarConexaoLinkedIn(req, res, url);
  }

  const file = path.join(__dirname, 'painel-cobrancas.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('Erro: ' + err.message); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, () => console.log('🌐 Servidor rodando na porta ' + PORT));

// ===== LAUNCHPAD: OAuth real do LinkedIn =====
// Só funciona quando LINKEDIN_CLIENT_ID/SECRET e LAUNCHPAD_ENCRYPTION_KEY estiverem
// configurados no Railway. Até lá, o botão "Conectar" do Orbit usa o modo simulado
// (100% client-side, não passa por aqui) — nunca finge uma conexão real sem essas
// credenciais configuradas.
function linkedinConfigurado() {
  return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

function redirectUriLaunchpad(req) {
  return `https://${req.headers.host}/api/launchpad/linkedin/callback`;
}

function iniciarConexaoLinkedIn(req, res, url) {
  if (!linkedinConfigurado()) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>App do LinkedIn ainda não configurado neste ambiente. Use o modo simulado no Orbit por enquanto.</p>');
    return;
  }
  const clienteId = url.searchParams.get('clienteId') || '';
  const accountType = url.searchParams.get('accountType') || 'personal';
  const state = Buffer.from(JSON.stringify({ clienteId, accountType })).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUriLaunchpad(req),
    state,
    scope: 'openid profile w_member_social',
  });
  res.writeHead(302, { Location: `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}` });
  res.end();
}

async function finalizarConexaoLinkedIn(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) { res.writeHead(400); res.end('Faltou code/state do LinkedIn.'); return; }
  let clienteId, accountType;
  try {
    ({ clienteId, accountType } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')));
  } catch (e) { res.writeHead(400); res.end('State inválido.'); return; }

  try {
    const tokenResp = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUriLaunchpad(req),
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = tokenResp.data;

    const userResp = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const perfil = userResp.data;

    const { error: dbError } = await supabase.from('launchpad_social_connections').upsert({
      cliente_id: clienteId,
      platform: 'linkedin',
      account_type: accountType,
      external_account_id: perfil.sub,
      account_name: perfil.name,
      account_avatar_url: perfil.picture || null,
      encrypted_access_token: encriptarTokenLP(access_token),
      encrypted_refresh_token: refresh_token ? encriptarTokenLP(refresh_token) : null,
      token_expires_at: new Date(Date.now() + (expires_in || 0) * 1000).toISOString(),
      scopes: 'openid profile w_member_social',
      connection_status: 'connected',
      is_mock: false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'cliente_id,platform,account_type' });

    if (dbError) {
      console.error('[LAUNCHPAD] Erro ao salvar conexao do LinkedIn no Supabase:', dbError.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>Login no LinkedIn funcionou, mas houve um erro ao salvar a conexão: ' + dbError.message + '. Tente novamente ou avise o suporte.</p>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Conta do LinkedIn conectada com sucesso! Pode fechar esta aba e voltar pro Orbit.</p>');
  } catch (err) {
    console.error('[LAUNCHPAD] Erro no callback do LinkedIn:', err.response?.data || err.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Erro ao conectar com o LinkedIn: ' + (err.response?.data?.error_description || err.message) + '</p>');
  }
}

function chaveCriptografiaLP() {
  const b64 = process.env.LAUNCHPAD_ENCRYPTION_KEY;
  if (!b64) throw new Error('LAUNCHPAD_ENCRYPTION_KEY não configurada.');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('LAUNCHPAD_ENCRYPTION_KEY precisa decodificar para 32 bytes.');
  return key;
}

function encriptarTokenLP(texto) {
  const crypto = require('crypto');
  const key = chaveCriptografiaLP();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decriptarTokenLP(payloadB64) {
  const crypto = require('crypto');
  const key = chaveCriptografiaLP();
  const raw = Buffer.from(payloadB64, 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// Publica no LinkedIn de verdade (Community Management API). Só é chamado quando a
// conexão NÃO é simulada — conexões is_mock nunca chegam aqui.
async function publicarNoLinkedInReal(post, conexao) {
  const accessToken = decriptarTokenLP(conexao.encrypted_access_token);
  const body = {
    author: conexao.account_type === 'company' ? `urn:li:organization:${conexao.external_account_id}` : `urn:li:person:${conexao.external_account_id}`,
    commentary: post.content,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  const resp = await axios.post('https://api.linkedin.com/rest/posts', body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202405',
    },
  });
  const urn = resp.headers['x-restli-id'] || resp.headers['x-linkedin-id'] || null;
  return { externalPostId: urn, externalPostUrl: urn ? `https://www.linkedin.com/feed/update/${urn}` : null, simulado: false };
}

// Roda a cada 2 minutos: pega posts agendados cuja hora já chegou e publica —
// de verdade se a conta for real, ou de forma simulada (claramente marcada,
// nunca apresentada como real) se a conta for [SIMULADO].
async function publicarLaunchpad() {
  const { data: posts, error } = await supabase
    .from('launchpad_posts')
    .select('*, clientes(nome), launchpad_social_connections(*)')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString());
  if (error) { console.error('[LAUNCHPAD] Erro ao buscar agendados:', error.message); return; }
  if (!posts?.length) return;

  for (const post of posts) {
    const conexao = post.launchpad_social_connections;
    if (!conexao || conexao.connection_status !== 'connected') {
      await supabase.from('launchpad_posts').update({ status: 'failed' }).eq('id', post.id);
      continue;
    }
    const { error: lockError } = await supabase
      .from('launchpad_posts')
      .update({ status: 'publishing' })
      .eq('id', post.id)
      .eq('status', 'scheduled');
    if (lockError) continue;

    const tentativa = (post.attempt_count || 0) + 1;
    try {
      let resultado;
      if (conexao.is_mock || !linkedinConfigurado()) {
        await new Promise((r) => setTimeout(r, 300));
        resultado = { externalPostId: 'mock-post-' + post.id, externalPostUrl: null, simulado: true };
      } else {
        resultado = await publicarNoLinkedInReal(post, conexao);
      }
      await supabase.from('launchpad_posts').update({
        status: 'published',
        published_at: new Date().toISOString(),
        external_post_id: resultado.externalPostId,
        external_post_url: resultado.externalPostUrl,
        attempt_count: tentativa,
      }).eq('id', post.id);
      await supabase.from('launchpad_publishing_attempts').insert({
        post_id: post.id, attempt_number: tentativa, status: 'success',
        provider_response: JSON.stringify(resultado), completed_at: new Date().toISOString(),
      });
      console.log(`[LAUNCHPAD] ✅ ${resultado.simulado ? '[SIMULADO] ' : ''}Publicado para ${post.clientes?.nome}`);
    } catch (err) {
      await supabase.from('launchpad_posts').update({ status: 'failed', attempt_count: tentativa }).eq('id', post.id);
      await supabase.from('launchpad_publishing_attempts').insert({
        post_id: post.id, attempt_number: tentativa, status: 'failed',
        error_message: String(err.message || err), completed_at: new Date().toISOString(),
      });
      console.error(`[LAUNCHPAD] ❌ Erro ao publicar para ${post.clientes?.nome}:`, err.message);
    }
  }
}

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

async function enviarGroundControl() { await recuperarEnviosOrfaos();
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

// Launchpad: checa a cada 2 minutos por posts agendados prontos pra publicar.
cron.schedule('*/2 * * * *', async () => {
  await publicarLaunchpad();
});

console.log('🚀 Aftermoon Orbit + Ground Control rodando...');
console.log('⏰ Cobranças: 08:08 (horário de Brasília). Ground Control: checagem a cada 5 min, por horário configurado por cliente.');
async function recuperarEnviosOrfaos() {
  const { data: presos, error } = await supabase
  .from('ground_control_conteudo')
  .select('*, clientes(nome, telefone)')
  .eq('status', 'Enviando');
  if (error || !presos || presos.length === 0) return;
  console.log('[GROUND CONTROL] ' + presos.length + ' item(ns) preso(s) em Enviando de execucao anterior, verificando entrega real...');

for (const item of presos) {
  const cliente = item.clientes;
  if (!cliente) {
    await supabase.from('ground_control_conteudo').update({ status: 'Falhou' }).eq('id', item.id);
    continue;
  }
  try {
    const { data } = await axios.post(
      EVOLUTION_URL + '/chat/findMessages/' + EVOLUTION_INSTANCE,
      { where: { key: { remoteJid: cliente.telefone + '@s.whatsapp.net' } } },
      { headers: { apikey: EVOLUTION_KEY } }
      );
    const registros = (data && data.messages && data.messages.records ? data.messages.records : []).filter(function(r) { return r.key && r.key.fromMe; });
    const match = registros.find(function(r) { return r.message && r.message.conversation && r.message.conversation.includes(item.tema); });
    const statusHist = (match && match.MessageUpdate ? match.MessageUpdate.map(function(m) { return m.status; }) : []);
    const entregue = statusHist.includes('DELIVERY_ACK') || statusHist.includes('READ');

                        await supabase.from('ground_control_conteudo').update({ status: entregue ? 'Enviado' : 'Falhou', enviado_em: new Date().toISOString() }).eq('id', item.id);

  if (entregue) {
    await supabase.from('ground_control_log').insert({ cliente_nome: cliente.nome, tipo: item.tipo, tema: item.tema, telefone: cliente.telefone });
    console.log('[GROUND CONTROL] Recuperado (entrega confirmada): ' + cliente.nome + ' - ' + item.tema);
  } else {
    console.log('[GROUND CONTROL] Recuperado como Falhou (sem confirmacao de entrega): ' + cliente.nome + ' - ' + item.tema);
  }
  } catch (err) {
    console.error('[GROUND CONTROL] Erro ao recuperar item preso ' + item.id + ':', err.message);
  }
}
}
