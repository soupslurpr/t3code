import { useNavigation } from "@react-navigation/native";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { useCallback, useState } from "react";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
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
  const openLink = useOpenPullRequest();
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
      if (presentation.href) void openLink(presentation.href);
    },
    [navigation, openLink, props.environmentId, props.threadId, props.workspaceRoot],
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
  const styles = useMarkdownPreviewStyles();
  const resolveImageSource = useMarkdownImageSource(props);
  const onImagePress = useCallback(
    (href: string) => {
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
        imageEmbed: true,
      });
      if (media?.kind === "image") setExpandedFile(media.source);
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );

  return (
    <>
      <SelectableMarkdownText
        markdown={props.markdown}
        textStyle={styles.nativeTextStyle}
        onLinkPress={onLinkPress}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onImagePress={onImagePress}
      />
      <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
    </>
  );
}
