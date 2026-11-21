// Startup recovery must remain readable when the main application and its translation runtime fail.
const translations = {
  en: [
    "Open the fork recovery guide",
    "Run triage on the server with the CLI from the installed fork package. The recovery guide explains how to restore a missing launcher.",
  ],
  de: [
    "Wiederherstellungsanleitung für den Fork öffnen",
    "Führe die Diagnose auf dem Server mit der CLI des installierten Fork-Pakets aus. Die Anleitung erklärt, wie du einen fehlenden Starter wiederherstellst.",
  ],
  es: [
    "Abrir la guía de recuperación del fork",
    "Ejecuta el diagnóstico en el servidor con la CLI del paquete del fork instalado. La guía explica cómo restaurar un lanzador que falta.",
  ],
  fr: [
    "Ouvrir le guide de récupération du fork",
    "Lancez le diagnostic sur le serveur avec la CLI du paquet du fork installé. Le guide explique comment restaurer le lanceur s’il manque.",
  ],
  ja: [
    "フォークの復旧ガイドを開く",
    "インストール済みのフォークの CLI を使い、サーバー上で診断を実行してください。ランチャーが見つからない場合の復元方法は復旧ガイドにあります。",
  ],
  ko: [
    "포크 복구 가이드 열기",
    "서버에서 설치된 포크 패키지의 CLI로 진단을 실행하세요. 실행기가 없을 때 복원하는 방법은 복구 가이드에서 확인할 수 있습니다.",
  ],
  "pt-BR": [
    "Abrir o guia de recuperação do fork",
    "Execute o diagnóstico no servidor com a CLI do pacote do fork instalado. O guia explica como restaurar o inicializador caso ele esteja ausente.",
  ],
  ru: [
    "Открыть руководство по восстановлению форка",
    "Запустите диагностику на сервере с помощью CLI из установленного пакета форка. В руководстве описано, как восстановить отсутствующую программу запуска.",
  ],
  sv: [
    "Öppna forkens återställningsguide",
    "Kör felsökningen på servern med kommandoradsverktyget från det installerade forkpaketet. Guiden visar hur du återställer ett startprogram som saknas.",
  ],
  zh: [
    "打开分支版本恢复指南",
    "请在服务器上使用已安装的分支版本软件包中的 CLI 运行诊断。若缺少启动器，请参阅恢复指南了解还原方法。",
  ],
} as const;

export function bootRecoveryText(locale = "en") {
  const language = locale.split(/[-_]/)[0]?.toLowerCase();
  const key = language === "pt" ? "pt-BR" : (language ?? "en");
  const [guide, triage] = Object.hasOwn(translations, key)
    ? translations[key as keyof typeof translations]
    : translations.en;
  return { guide, triage };
}
