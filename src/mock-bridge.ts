import {
    DeviceConnectType,
    DeviceStatus,
    EvenAppMethod,
    OsEventTypeList,
    type CreateStartUpPageContainer,
    type DeviceInfo,
    type EvenHubEvent,
    type ImageRawDataUpdate,
    type ImageRawDataUpdateResult,
    type RebuildPageContainer,
    type StartUpPageCreateResult,
    type TextContainerUpgrade,
    type UserInfo,
    Sys_ItemEvent,
} from '@evenrealities/even_hub_sdk';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from './constants';

export class MockBridge {
    private static instance: MockBridge;
    private deviceStatusListeners: ((status: DeviceStatus) => void)[] = [];
    private eventListeners: ((event: EvenHubEvent) => void)[] = [];
    private currentContainers: any[] = []; // Store container state for visualization

    // Singleton pattern to match SDK behavior
    static getInstance(): MockBridge {
        if (!MockBridge.instance) {
            MockBridge.instance = new MockBridge();
        }
        return MockBridge.instance;
    }

    constructor() {
        console.log('[MockBridge] Initialized');
        this.renderSimulatorUI();
    }

    // --- Device & User Info ---

    async getUserInfo(): Promise<UserInfo> {
        console.log('[MockBridge] getUserInfo');
        return {
            uid: 12345,
            name: 'Mock User',
            avatar: '',
            country: 'US',
            toJson: () => ({}),
        } as any;
    }

    async getDeviceInfo(): Promise<DeviceInfo | null> {
        console.log('[MockBridge] getDeviceInfo');
        return {
            model: 1, // G1/G2
            sn: 'MOCK_SN_001',
            status: {
                connectType: DeviceConnectType.Connected,
            },
        } as any;
    }

    // --- Storage ---

    async setLocalStorage(key: string, value: string): Promise<boolean> {
        console.log(`[MockBridge] setLocalStorage: ${key} = ${value}`);
        localStorage.setItem(`even_${key}`, value);
        return true;
    }

    async getLocalStorage(key: string): Promise<string> {
        const val = localStorage.getItem(`even_${key}`) || '';
        console.log(`[MockBridge] getLocalStorage: ${key} -> ${val}`);
        return val;
    }

    // --- Display / Containers ---

    async createStartUpPageContainer(
        container: CreateStartUpPageContainer,
    ): Promise<StartUpPageCreateResult> {
        console.log('[MockBridge] createStartUpPageContainer', container);
        this.updateSimulatorDisplay(container);
        return 0; // Success
    }

    async rebuildPageContainer(
        container: RebuildPageContainer,
    ): Promise<boolean> {
        console.log('[MockBridge] rebuildPageContainer', container);
        this.updateSimulatorDisplay(container);
        return true;
    }

    async updateImageRawData(
        data: ImageRawDataUpdate,
    ): Promise<ImageRawDataUpdateResult> {
        console.log('[MockBridge] updateImageRawData', data);

        const screen = document.getElementById('sim-screen');
        if (screen && data.containerID) {
            const imgDiv = screen.querySelector(`#img-${data.containerID}`);
            const canvas = imgDiv?.querySelector('canvas');
            if (canvas && data.imageData) {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const width = canvas.width;
                    const height = canvas.height;
                    // Assuming data is standard array of 0/255 for simulator
                    const pixels = data.imageData as number[];
                    const imgData = ctx.createImageData(width, height);
                    for (let i = 0; i < pixels.length; i++) {
                        const val = pixels[i]; // 0 or 255
                        const offset = i * 4;
                        imgData.data[offset] = 0;   // R
                        imgData.data[offset + 1] = val; // G (Green phosphor)
                        imgData.data[offset + 2] = 0; // B
                        imgData.data[offset + 3] = val > 0 ? 255 : 0; // Alpha
                    }
                    ctx.putImageData(imgData, 0, 0);
                }
            }
        }

        return { success: true } as any;
    }

    async textContainerUpgrade(
        container: TextContainerUpgrade,
    ): Promise<boolean> {
        console.log('[MockBridge] textContainerUpgrade', container);
        return true;
    }

    async shutDownPageContainer(exitMode?: number): Promise<boolean> {
        console.log(`[MockBridge] shutDownPageContainer mode=${exitMode}`);
        this.clearSimulatorDisplay();
        return true;
    }

    // --- Events ---

    onDeviceStatusChanged(callback: (status: DeviceStatus) => void): () => void {
        this.deviceStatusListeners.push(callback);
        // Simulate immediate connection
        setTimeout(() => {
            callback({
                connectType: DeviceConnectType.Connected,
                batteryLevel: 100,
                isWearing: true,
            } as any);
        }, 100);
        return () => {
            this.deviceStatusListeners = this.deviceStatusListeners.filter(
                (cb) => cb !== callback,
            );
        };
    }

    onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void {
        this.eventListeners.push(callback);
        return () => {
            this.eventListeners = this.eventListeners.filter((cb) => cb !== callback);
        };
    }

    // --- Simulator Helpers ---

    triggerEvent(type: OsEventTypeList) {
        console.log(`[MockBridge] Triggering event: ${type}`);
        const sysEvent = new Sys_ItemEvent({ eventType: type });
        const event: EvenHubEvent = {
            sysEvent,
            toJson: () => ({ sysEvent: sysEvent.toJson() }),
        } as any;
        this.eventListeners.forEach((cb) => cb(event));
    }

    // Visualization
    private renderSimulatorUI() {
        const container = document.getElementById('simulator-container');
        if (!container) return;

        container.innerHTML = `
      <div style="border: 2px solid #333; width: ${DISPLAY_WIDTH}px; height: ${DISPLAY_HEIGHT}px; position: relative; background: #000; overflow: hidden;" id="sim-screen">
        <div style="color: #666; font-family: monospace; padding: 10px;">Waiting for content...</div>
      </div>
      <div style="margin-top: 10px; display: flex; gap: 8px;">
        <button id="btn-up">Swipe Up (Prev)</button>
        <button id="btn-down">Swipe Down (Next)</button>
        <button id="btn-tap">Tap</button>
        <button id="btn-dbl">Double Tap</button>
      </div>
    `;

        document.getElementById('btn-up')?.addEventListener('click', () => {
            this.triggerEvent(OsEventTypeList.SCROLL_TOP_EVENT);
        });
        document.getElementById('btn-down')?.addEventListener('click', () => {
            this.triggerEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT);
        });
        document.getElementById('btn-tap')?.addEventListener('click', () => {
            this.triggerEvent(OsEventTypeList.CLICK_EVENT); // Note: SDK might map CLICK to 0/undefined
        });
        document.getElementById('btn-dbl')?.addEventListener('click', () => {
            this.triggerEvent(OsEventTypeList.DOUBLE_CLICK_EVENT);
        });
    }

    private updateSimulatorDisplay(container: CreateStartUpPageContainer | RebuildPageContainer) {
        const screen = document.getElementById('sim-screen');
        if (!screen) return;

        screen.innerHTML = ''; // Clear current

        // Handle Text Containers
        if (container.textObject) {
            container.textObject.forEach(obj => {
                const div = document.createElement('div');
                div.style.position = 'absolute';
                div.style.left = `${obj.xPosition}px`;
                div.style.top = `${obj.yPosition}px`;
                div.style.width = `${obj.width}px`;
                div.style.height = `${obj.height}px`;
                div.style.border = obj.borderWidth ? `${obj.borderWidth}px solid #0f0` : 'none';
                div.style.color = '#0f0'; // Green phosphor style
                div.style.fontFamily = 'monospace';
                div.style.fontSize = '18px'; // Adjusted for 55-60 chars/line on 640px width
                div.style.whiteSpace = 'pre'; // Respect strict pagination, no browser wrapping
                div.style.overflow = 'hidden';
                div.textContent = obj.content || '';
                div.style.padding = '4px';
                div.style.boxSizing = 'border-box';

                if (obj.isEventCapture) {
                    div.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
                }

                screen.appendChild(div);
            });
        }

        // Handle List Containers (Visual approximation)
        if (container.listObject) {
            container.listObject.forEach(obj => {
                const div = document.createElement('div');
                div.style.position = 'absolute';
                div.style.left = `${obj.xPosition}px`;
                div.style.top = `${obj.yPosition}px`;
                div.style.width = `${obj.width}px`;
                div.style.height = `${obj.height}px`;
                div.style.border = `${obj.borderWidth || 1}px solid #0f0`;
                div.style.color = '#0f0';

                // Simulating items
                if (obj.itemContainer?.itemName) {
                    obj.itemContainer.itemName.forEach(item => {
                        const itemDiv = document.createElement('div');
                        itemDiv.textContent = item;
                        itemDiv.style.padding = '2px';
                        div.appendChild(itemDiv);
                    });
                }
                screen.appendChild(div);
            });
        }

        // Handle Image Containers (Visual approximation)
        if (container.imageObject) {
            container.imageObject.forEach(obj => {
                const div = document.createElement('div');
                div.style.position = 'absolute';
                div.style.left = `${obj.xPosition}px`;
                div.style.top = `${obj.yPosition}px`;
                div.style.width = `${obj.width}px`;
                div.style.height = `${obj.height}px`;
                div.style.border = '1px dashed #0f0';
                div.style.color = '#0f0';
                // div.textContent = `[Image: ${obj.containerName}]`; // Canvas covers this anyway
                div.id = `img-${obj.containerID}`;

                // Add a canvas for pixel data
                const canvas = document.createElement('canvas');
                canvas.width = obj.width || 0;
                canvas.height = obj.height || 0;
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                canvas.style.opacity = '0.9'; // Slightly transparent to see border
                div.appendChild(canvas);

                screen.appendChild(div);
            });
        }
    }

    private clearSimulatorDisplay() {
        const screen = document.getElementById('sim-screen');
        if (screen) screen.innerHTML = '';
    }

    async callEvenApp(method: EvenAppMethod | string, params?: any): Promise<any> {
        console.log(`[MockBridge] callEvenApp: ${method}`, params);
    }

    async audioControl(isOpen: boolean): Promise<boolean> {
        console.log(`[MockBridge] audioControl: ${isOpen}`);
        return true;
    }

}
