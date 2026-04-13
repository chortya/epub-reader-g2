import {
  ImageContainerProperty,
  ImageRawDataUpdate,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk';
import type { SplashBridge } from 'even-toolkit/splash';

type Bridge = {
  rebuildPageContainer(container: RebuildPageContainer): Promise<number>;
  updateImageRawData(data: ImageRawDataUpdate): Promise<any>;
};

/**
 * Adapter that implements even-toolkit's SplashBridge interface
 * using the raw SDK bridge methods (since we don't use EvenHubBridge).
 */
export function createSplashBridgeAdapter(bridge: Bridge): SplashBridge {
  return {
    async showHomePage(
      menuText: string,
      imageTiles?: { id: number; name: string; x: number; y: number; w: number; h: number }[],
    ): Promise<void> {
      const textObjects: TextContainerProperty[] = [];
      const imageObjects: ImageContainerProperty[] = [];

      // Add a text container for menu text (required for event capture)
      if (menuText) {
        textObjects.push(
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 240,
            width: 576,
            height: 48,
            containerID: 10,
            containerName: 'splash-text',
            content: menuText,
            isEventCapture: 1,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 0,
          }),
        );
      } else {
        // Need at least one container with event capture
        textObjects.push(
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: 1,
            height: 1,
            containerID: 10,
            containerName: 'splash-evt',
            content: '',
            isEventCapture: 1,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 0,
          }),
        );
      }

      // Add image tile containers
      if (imageTiles) {
        for (const tile of imageTiles) {
          imageObjects.push(
            new ImageContainerProperty({
              xPosition: tile.x,
              yPosition: tile.y,
              width: tile.w,
              height: tile.h,
              containerID: tile.id,
              containerName: tile.name,
            }),
          );
        }
      }

      await bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: textObjects.length + imageObjects.length,
          textObject: textObjects,
          imageObject: imageObjects.length > 0 ? imageObjects : undefined,
        }),
      );
    },

    async sendImage(
      containerId: number,
      containerName: string,
      pngBytes: Uint8Array,
    ): Promise<void> {
      await bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: containerId,
          containerName: containerName,
          imageData: pngBytes,
        }),
      );
    },
  };
}
