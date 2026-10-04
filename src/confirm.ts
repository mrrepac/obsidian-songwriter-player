import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";

/** A yes/no question with the dangerous answer spelled out on its button. */
export class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private heading: string,
    private body: string,
    private confirmText: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
      .addButton((b) => b
        .setButtonText(this.confirmText)
        .setWarning()
        .onClick(() => {
          if (this.resolved) return;
          this.resolved = true;
          this.close();
          this.onConfirm();
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}
