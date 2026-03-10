chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-filter') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'toggleCRT' });
    }
  }
});
