import { useNavigation } from "@react-navigation/native";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import { useCallback, useState } from "react";
import { Markdown } from "react-native-nitro-markdown";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { fileRoutePathSegments } from "../files/filePath";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { resolveFileChipTarget } from "./fileChipMenu";
import { ThreadMarkdownImage, ThreadMarkdownImageUnavailable } from "./ThreadMarkdownImage";

/** Keeps pending question links scoped to the environment and workspace being discussed. */
export function QuestionMarkdown(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
}) {
  const navigation = useNavigation();
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const onLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const target = resolveFileChipTarget(href, props.workspaceRoot);
        const path = target?.relativePath ?? target?.fullPath;
        if (path) {
          navigation.navigate("ThreadFile", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: fileRoutePathSegments(path),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
        }
        return;
      }
      if (presentation.href) void tryOpenExternalUrl(presentation.href, "markdown-link");
    },
    [navigation, props.environmentId, props.threadId, props.workspaceRoot],
  );
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const media = resolveMediaSource(image.href, {
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
        imageEmbed: true,
      });
      if (media?.access === "direct") return null;
      if (media === null || media.kind !== "image" || media.access === "unavailable") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          resource={media.resource}
          alt={image.alt}
          srcFragment={media.srcFragment}
          onPressPreview={setExpandedFile}
        />
      );
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const styles = useMarkdownPreviewStyles(renderImage, onLinkPress);

  return (
    <>
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText
          markdown={props.markdown}
          textStyle={styles.nativeTextStyle}
          onLinkPress={onLinkPress}
          renderImage={renderImage}
        />
      ) : (
        <Markdown
          options={{ gfm: true }}
          renderers={styles.renderers}
          styles={styles.styles}
          theme={styles.theme}
        >
          {props.markdown}
        </Markdown>
      )}
      <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
    </>
  );
}
