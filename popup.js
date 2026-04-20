// Voix disponibles par langue (nom affiché → nom Azure)
const VOICES_BY_LANG = {
  fr: [
    { label: 'Denise (femme)',   value: 'fr-FR-DeniseNeural' },
    { label: 'Henri (homme)',    value: 'fr-FR-HenriNeural' },
    { label: 'Vivienne (femme)', value: 'fr-FR-VivienneMultilingualNeural' },
    { label: 'Rémy (homme)',     value: 'fr-FR-RemyMultilingualNeural' },
    { label: 'Eloise (enfant)',  value: 'fr-FR-EloiseNeural' },
  ],
  es: [
    { label: 'Elvira (femme)',  value: 'es-ES-ElviraNeural' },
    { label: 'Álvaro (homme)', value: 'es-ES-AlvaroNeural' },
    { label: 'Triana (femme)', value: 'es-ES-TrianaNeural' },
  ],
  de: [
    { label: 'Katja (femme)',   value: 'de-DE-KatjaNeural' },
    { label: 'Conrad (homme)',  value: 'de-DE-ConradNeural' },
    { label: 'Amala (femme)',   value: 'de-DE-AmalaNeural' },
  ],
  pt: [
    { label: 'Francisca (femme)', value: 'pt-BR-FranciscaNeural' },
    { label: 'Antonio (homme)',   value: 'pt-BR-AntonioNeural' },
  ],
  it: [
    { label: 'Elsa (femme)',    value: 'it-IT-ElsaNeural' },
    { label: 'Diego (homme)',   value: 'it-IT-DiegoNeural' },
    { label: 'Isabella (femme)', value: 'it-IT-IsabellaNeural' },
  ],
  zh: [
    { label: 'Xiaoxiao (femme)', value: 'zh-CN-XiaoxiaoNeural' },
    { label: 'Yunxi (homme)',    value: 'zh-CN-YunxiNeural' },
    { label: 'Xiaoyi (femme)',   value: 'zh-CN-XiaoyiNeural' },
  ],
  ja: [
    { label: 'Nanami (femme)',  value: 'ja-JP-NanamiNeural' },
    { label: 'Keita (homme)',   value: 'ja-JP-KeitaNeural' },
  ],
  ar: [
    { label: 'Zariyah (femme)', value: 'ar-SA-ZariyahNeural' },
    { label: 'Hamed (homme)',   value: 'ar-SA-HamedNeural' },
  ],
};

const LANG_LABELS = {
  fr: 'Français', es: 'Español', de: 'Deutsch',
  pt: 'Português', it: 'Italiano', zh: '中文', ja: '日本語', ar: 'العربية',
};

document.addEventListener('DOMContentLoaded', () => {
  const langSelect  = document.getElementById('lang');
  const voiceSelect = document.getElementById('voice');

  // Remplir le sélecteur de langues
  Object.entries(LANG_LABELS).forEach(([code, label]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    langSelect.appendChild(opt);
  });

  // Mettre à jour les voix quand la langue change
  function updateVoices(lang, savedVoice) {
    voiceSelect.innerHTML = '';
    (VOICES_BY_LANG[lang] || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      if (v.value === savedVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
  }

  langSelect.addEventListener('change', () => {
    updateVoices(langSelect.value, null);
    chrome.storage.sync.set({ outputLang: langSelect.value });
  });

  // Restaurer les préférences sauvegardées
  chrome.storage.sync.get(['outputLang', 'outputVoice'], result => {
    const lang = result.outputLang || 'fr';
    langSelect.value = lang;
    updateVoices(lang, result.outputVoice);
  });

  document.getElementById('btn-activate').addEventListener('click', () => {
    const lang  = langSelect.value;
    const voice = voiceSelect.value;
    chrome.storage.sync.set({ outputLang: lang, outputVoice: voice, active: true });
    sendToTab({ action: 'activate', lang, voice });
    window.close();
  });

  document.getElementById('btn-deactivate').addEventListener('click', () => {
    chrome.storage.sync.set({ active: false });
    sendToTab({ action: 'deactivate' });
    window.close();
  });

  function sendToTab(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, message);
    });
  }
});
