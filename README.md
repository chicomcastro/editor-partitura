# Pauta — editor de partituras offline pro iPad

**App:** https://chicomcastro.github.io/editor-partitura/

PWA pra rascunhar partituras no iPad sem internet, com o dedo. Abre arquivos do MuseScore
(`.mscz`/`.mscx`, versões 2–4) e MusicXML, e exporta MusicXML — que o MuseScore abre direto
(Arquivo › Abrir) pra você terminar e salvar como `.mscz`.

## Instalar no iPad (antes de ficar offline)
1. Abra o link no **Safari** → Compartilhar → **Adicionar à Tela de Início**.
2. Abra pelo ícone uma vez com internet (aparece "Pronto pra usar offline ✈️").
3. Use **sempre pelo ícone**: o app da Tela de Início tem armazenamento próprio, separado da aba do Safari,
   e o iOS não apaga os dados dele.

## Fluxo
- **Importar**: biblioteca › Importar arquivo… (Arquivos/iCloud/AirDrop) → `.mscz`, `.mxl`, `.musicxml`.
- **Escrever (✏️)**: escolha a figura, encoste o dedo na pauta — aparece a nota fantasma com o nome
  (e toca); deslize pra ajustar altura/tempo e solte pra gravar.
- **Selecionar (✋)**: toque numa nota, arraste pra mudar a altura; ♯ ♭ ♮, ▲▼ meio tom, ligadura,
  tercina, apagar; figura nova muda a duração.
- **🎹**: piano virtual escreve na posição do cursor e avança. **Acorde (+)** empilha notas.
- **Vozes 1–4**, **Compasso** (inserir/apagar/copiar/colar/transpor, fórmula, armadura, clave,
  andamento, ritornelo, anacruse), **Partitura** (toque no título: instrumentos, concert pitch).
- **▶** toca com síntese offline (cursor acompanha), metrônomo opcional.
- **Exportar** → `.musicxml` pela folha de compartilhar (AirDrop pro Mac / salvar em Arquivos).
- Teclado físico: A–G (Shift = acorde), 2–7 figuras, `.` ponto, `0` pausa, setas, ⌘Z/⇧⌘Z, espaço.

## O que não passa pelo app
Dinâmicas, articulações, textos, linhas de 8va, notas de enfeite e percussão detalhada são
ignorados na importação (as alturas de 8va viram as alturas reais). Pra preservar isso numa
partitura existente, use o app pra rascunhar trechos e cole no original no MuseScore.

## Stack e validação
Vite + TypeScript puro, VexFlow 4 (render), fflate (unzip), Web Audio, IndexedDB, vite-plugin-pwa.

- `npm test` — unitários das operações de edição.
- `npm run test:e2e` — Playwright no WebKit emulando iPad: toque, arraste, seleção, piano,
  import/play/export e reabrir **offline**.
- `npm run corpus -- <dir>` — compara o importador contra o MusicXML gerado pelo próprio MuseScore
  (`mscore -o x.musicxml x.mscz`) e faz roundtrip do export. Num corpus de 490 `.mscz` reais:
  100% das notas idênticas em 457/486 (o resto é percussão), roundtrip 100% em 488/490.
