const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const file = path.join(__dirname, 'painel-cobrancas.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Erro: ' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Rodando na porta ' + PORT));
