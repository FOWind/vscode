/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { Gesture } from 'vs/base/browser/touch';
import { Codicon } from 'vs/base/common/codicons';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { ThemeIcon } from 'vs/base/common/themables';
import 'vs/css!./lightBulbWidget';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from 'vs/editor/browser/editorBrowser';
import { EditorOption, ShowAiIconMode } from 'vs/editor/common/config/editorOptions';
import { IPosition } from 'vs/editor/common/core/position';
import { computeIndentLevel } from 'vs/editor/common/model/utils';
import { autoFixCommandId, quickFixCommandId } from 'vs/editor/contrib/codeAction/browser/codeAction';
import type { CodeActionSet, CodeActionTrigger } from 'vs/editor/contrib/codeAction/common/types';
import * as nls from 'vs/nls';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';

namespace LightBulbState {

	export const enum Type {
		Hidden,
		Showing,
	}

	export const Hidden = { type: Type.Hidden } as const;

	export class Showing {
		readonly type = Type.Showing;

		constructor(
			public readonly actions: CodeActionSet,
			public readonly trigger: CodeActionTrigger,
			public readonly editorPosition: IPosition,
			public readonly widgetPosition: IContentWidgetPosition,
		) { }
	}

	export type State = typeof Hidden | Showing;
}

export class LightBulbWidget extends Disposable implements IContentWidget {

	public static readonly ID = 'editor.contrib.lightbulbWidget';

	private static readonly _posPref = [ContentWidgetPositionPreference.EXACT];

	private readonly _domNode: HTMLElement;

	private readonly _onClick = this._register(new Emitter<{ readonly x: number; readonly y: number; readonly actions: CodeActionSet; readonly trigger: CodeActionTrigger }>());
	public readonly onClick = this._onClick.event;

	private _state: LightBulbState.State = LightBulbState.Hidden;
	private _iconClasses: string[] = [];

	private _preferredKbLabel?: string;
	private _quickFixKbLabel?: string;

	constructor(
		private readonly _editor: ICodeEditor,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
	) {
		super();

		this._domNode = dom.$('div.lightBulbWidget');

		this._register(Gesture.ignoreTarget(this._domNode));

		this._editor.addContentWidget(this);

		this._register(this._editor.onDidChangeModelContent(_ => {
			// cancel when the line in question has been removed
			const editorModel = this._editor.getModel();
			if (this.state.type !== LightBulbState.Type.Showing || !editorModel || this.state.editorPosition.lineNumber >= editorModel.getLineCount()) {
				this.hide();
			}
		}));

		this._register(dom.addStandardDisposableGenericMouseDownListener(this._domNode, e => {
			if (this.state.type !== LightBulbState.Type.Showing) {
				return;
			}
			const focusEditor = () => {
				this._editor.focus();
				e.preventDefault();
			};

			const option = this._editor.getOption(EditorOption.lightbulb).experimental.showAiIcon;
			if (
				(option === ShowAiIconMode.On || option === ShowAiIconMode.OnCode)
				&& this.state.actions.allAIFixes
				&& this.state.actions.validActions.length === 1
			) {
				const action = this.state.actions.validActions[0].action;
				if (action.command?.id) {
					commandService.executeCommand(action.command.id, ...(action.command.arguments || []));
				}
				focusEditor();
				return;
			}
			// Make sure that focus / cursor location is not lost when clicking widget icon
			focusEditor();
			// a bit of extra work to make sure the menu
			// doesn't cover the line-text
			const { top, height } = dom.getDomNodePagePosition(this._domNode);
			const lineHeight = this._editor.getOption(EditorOption.lineHeight);

			let pad = Math.floor(lineHeight / 3);
			if (this.state.widgetPosition.position !== null && this.state.widgetPosition.position.lineNumber < this.state.editorPosition.lineNumber) {
				pad += lineHeight;
			}

			this._onClick.fire({
				x: e.posx,
				y: top + height + pad,
				actions: this.state.actions,
				trigger: this.state.trigger,
			});
		}));

		this._register(dom.addDisposableListener(this._domNode, 'mouseenter', (e: MouseEvent) => {
			if ((e.buttons & 1) !== 1) {
				return;
			}
			// mouse enters lightbulb while the primary/left button
			// is being pressed -> hide the lightbulb
			this.hide();
		}));

		this._register(this._editor.onDidChangeConfiguration(e => {
			// hide when told to do so
			if (e.hasChanged(EditorOption.lightbulb)) {
				if (!this._editor.getOption(EditorOption.lightbulb).enabled) {
					this.hide();
				}
				this._updateLightBulbTitleAndIcon();
			}
		}));

		this._register(Event.runAndSubscribe(this._keybindingService.onDidUpdateKeybindings, () => {
			this._preferredKbLabel = this._keybindingService.lookupKeybinding(autoFixCommandId)?.getLabel() ?? undefined;
			this._quickFixKbLabel = this._keybindingService.lookupKeybinding(quickFixCommandId)?.getLabel() ?? undefined;

			this._updateLightBulbTitleAndIcon();
		}));
	}

	override dispose(): void {
		super.dispose();
		this._editor.removeContentWidget(this);
	}

	getId(): string {
		return 'LightBulbWidget';
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		return this._state.type === LightBulbState.Type.Showing ? this._state.widgetPosition : null;
	}

	public update(actions: CodeActionSet, trigger: CodeActionTrigger, atPosition: IPosition) {
		if (actions.validActions.length <= 0) {
			return this.hide();
		}

		const options = this._editor.getOptions();
		if (!options.get(EditorOption.lightbulb).enabled) {
			return this.hide();
		}

		const model = this._editor.getModel();
		if (!model) {
			return this.hide();
		}

		const { lineNumber, column } = model.validatePosition(atPosition);

		const tabSize = model.getOptions().tabSize;
		const fontInfo = options.get(EditorOption.fontInfo);
		const lineContent = model.getLineContent(lineNumber);
		const indent = computeIndentLevel(lineContent, tabSize);
		const lineHasSpace = fontInfo.spaceWidth * indent > 22;
		const isFolded = (lineNumber: number) => {
			return lineNumber > 2 && this._editor.getTopForLineNumber(lineNumber) === this._editor.getTopForLineNumber(lineNumber - 1);
		};

		let effectiveLineNumber = lineNumber;
		if (!lineHasSpace) {
			if (lineNumber > 1 && !isFolded(lineNumber - 1)) {
				effectiveLineNumber -= 1;
			} else if (!isFolded(lineNumber + 1)) {
				effectiveLineNumber += 1;
			} else if (column * fontInfo.spaceWidth < 22) {
				// cannot show lightbulb above/below and showing
				// it inline would overlay the cursor...
				return this.hide();
			}
		}

		this.state = new LightBulbState.Showing(actions, trigger, atPosition, {
			position: { lineNumber: effectiveLineNumber, column: !!model.getLineContent(effectiveLineNumber).match(/^\S\s*$/) ? 2 : 1 },
			preference: LightBulbWidget._posPref
		});
		this._editor.layoutContentWidget(this);
	}

	public hide(): void {
		if (this.state === LightBulbState.Hidden) {
			return;
		}

		this.state = LightBulbState.Hidden;
		this._editor.layoutContentWidget(this);
	}

	private get state(): LightBulbState.State { return this._state; }

	private set state(value) {
		this._state = value;
		this._updateLightBulbTitleAndIcon();
	}

	private _updateLightBulbTitleAndIcon(): void {
		this._domNode.classList.remove(...this._iconClasses);
		this._iconClasses = [];
		if (this.state.type !== LightBulbState.Type.Showing) {
			return;
		}
		const updateAutoFixLightbulbTitle = () => {
			if (this._preferredKbLabel) {
				this.title = nls.localize('preferredcodeActionWithKb', "Show Code Actions. Preferred Quick Fix Available ({0})", this._preferredKbLabel);
			}
		};
		const updateLightbulbTitle = () => {
			if (this._quickFixKbLabel) {
				this.title = nls.localize('codeActionWithKb', "Show Code Actions ({0})", this._quickFixKbLabel);
			} else {
				this.title = nls.localize('codeAction', "Show Code Actions");
			}
		};
		let icon: ThemeIcon;
		const option = this._editor.getOption(EditorOption.lightbulb).experimental.showAiIcon;
		if (option === ShowAiIconMode.On || option === ShowAiIconMode.OnCode) {
			if (option === ShowAiIconMode.On && this.state.actions.allAIFixes) {
				icon = Codicon.sparkleFilled;
				if (this.state.actions.allAIFixes && this.state.actions.validActions.length === 1) {
					if (this.state.actions.validActions[0].action.command?.id === `inlineChat.start`) {
						const keybinding = this._keybindingService.lookupKeybinding('inlineChat.start')?.getLabel() ?? undefined;
						this.title = keybinding ? nls.localize('codeActionStartInlineChatWithKb', 'Start Inline Chat ({0})', keybinding) : nls.localize('codeActionStartInlineChat', 'Start Inline Chat',);
					} else {
						this.title = nls.localize('codeActionTriggerAiAction', "Trigger AI Action");
					}
				} else {
					updateLightbulbTitle();
				}
			} else if (this.state.actions.hasAutoFix) {
				if (this.state.actions.hasAIFix) {
					icon = Codicon.lightbulbSparkleAutofix;
				} else {
					icon = Codicon.lightbulbAutofix;
				}
				updateAutoFixLightbulbTitle();
			} else if (this.state.actions.hasAIFix) {
				icon = Codicon.lightbulbSparkle;
				updateLightbulbTitle();
			} else {
				icon = Codicon.lightBulb;
				updateLightbulbTitle();
			}
		} else {
			if (this.state.actions.hasAutoFix) {
				icon = Codicon.lightbulbAutofix;
				updateAutoFixLightbulbTitle();
			} else {
				icon = Codicon.lightBulb;
				updateLightbulbTitle();
			}
		}
		this._iconClasses = ThemeIcon.asClassNameArray(icon);
		this._domNode.classList.add(...this._iconClasses);
	}

	private set title(value: string) {
		this._domNode.title = value;
	}
}
