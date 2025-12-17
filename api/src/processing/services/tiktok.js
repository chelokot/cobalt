import Cookie from "../cookie/cookie.js";

import { extract, normalizeURL } from "../url.js";
import { genericUserAgent } from "../../config.js";
import { updateCookie } from "../cookie/manager.js";
import { createStream } from "../../stream/manage.js";
import { convertLanguageCode } from "../../misc/language-codes.js";

const shortDomain = "https://vt.tiktok.com/";
const commentListURL = "https://www.tiktok.com/api/comment/list/";
const commentReplyURL = "https://www.tiktok.com/api/comment/list/reply/";
const commentRequestDefaults = {
    aid: "1988",
    count: "50",
};

const hasMore = (value) => {
    if (typeof value === "string") {
        const normalized = value.toLowerCase();
        return normalized === "1" || normalized === "true";
    }
    return value === true || value === 1;
};

const pickAvatar = (user) => {
    const options = [
        user?.avatar_thumb?.url_list,
        user?.avatar_medium?.url_list,
        user?.avatar_larger?.url_list,
    ];

    for (const list of options) {
        if (Array.isArray(list) && list.length) {
            return list[0];
        }
    }
};

const mapComment = (item, postId, parentId) => {
    if (!item?.cid) return;
    const user = item.user || {};

    return {
        id: String(item.cid),
        postId,
        parentId: parentId ? String(parentId) : null,
        text: typeof item.text === "string" ? item.text : "",
        createTime: typeof item.create_time === "number" ? item.create_time : undefined,
        likeCount: Number.isFinite(item.digg_count) ? item.digg_count : 0,
        replyCount: Number.isFinite(item.reply_comment_total) ? item.reply_comment_total : 0,
        user: {
            id: user.uid ? String(user.uid) : undefined,
            username: typeof user.unique_id === "string" ? user.unique_id : "",
            nickname: typeof user.nickname === "string" ? user.nickname : "",
            avatar: pickAvatar(user),
        }
    };
};

const buildHeaders = (cookie, referer) => {
    const headers = {
        "user-agent": genericUserAgent,
        referer,
    };
    const cookieValue = cookie.toString();
    if (cookieValue) {
        headers.cookie = cookieValue;
    }
    return headers;
};

const fetchCommentData = async (url, cookie, referer) => {
    try {
        const res = await fetch(url, {
            headers: buildHeaders(cookie, referer),
        });
        updateCookie(cookie, res.headers);

        if (!res.ok) return;
        return res.json().catch(() => undefined);
    } catch {
        return;
    }
};

const collectTopLevelComments = async (postId, cookie, referer, limit) => {
    const query = new URLSearchParams({
        ...commentRequestDefaults,
        aweme_id: postId,
        cursor: "0",
    });
    const comments = [];
    let cursor = "0";
    let total;

    while (true) {
        query.set("cursor", cursor);
        const data = await fetchCommentData(`${commentListURL}?${query.toString()}`, cookie, referer);
        if (!data || !Array.isArray(data.comments)) return;

        comments.push(
            ...data.comments
                .map(item => mapComment(item, postId, null))
                .filter(Boolean)
        );
        if (limit && comments.length >= limit) {
            break;
        }

        if (typeof data.total === "number") {
            total = data.total;
        } else if (typeof data.total_count === "number") {
            total = data.total_count;
        }

        const nextCursor = data.cursor !== undefined
            ? String(data.cursor)
            : String(Number(cursor) + data.comments.length);

        if (!hasMore(data.has_more ?? data.hasMore) || nextCursor === cursor) {
            break;
        }
        cursor = nextCursor;
    }

    return {
        comments: limit ? comments.slice(0, limit) : comments,
        total,
    };
};

const fetchComments = async (postId, cookie, authorHandle, limit) => {
    const maxCount = typeof limit === "number" && limit > 0 ? limit : undefined;
    const refererAuthor = authorHandle || "i";
    const referer = `https://www.tiktok.com/@${refererAuthor}/video/${postId}`;

    const topLevel = await collectTopLevelComments(postId, cookie, referer, maxCount);
    if (!topLevel) return;

    const comments = maxCount ? topLevel.comments.slice(0, maxCount) : topLevel.comments;

    return {
        total: topLevel.total ?? topLevel.comments.length,
        count: comments.length,
        comments,
    };
};

export default async function(obj) {
    const cookie = new Cookie({});
    let postId = obj.postId;

    if (!postId) {
        let html = await fetch(`${shortDomain}${obj.shortLink}`, {
            redirect: "manual",
            headers: {
                "user-agent": genericUserAgent.split(' Chrome/1')[0]
            }
        }).then(r => r.text()).catch(() => {});

        if (!html) return { error: "fetch.fail" };

        if (html.startsWith('<a href="https://')) {
            const extractedURL = html.split('<a href="')[1].split('?')[0];
            const { host, patternMatch } = extract(normalizeURL(extractedURL));
            if (host === "tiktok") {
                postId = patternMatch?.postId;
            }
        }
    }
    if (!postId) return { error: "fetch.short_link" };

    const res = await fetch(`https://www.tiktok.com/@i/video/${postId}`, {
        headers: {
            "user-agent": genericUserAgent,
            cookie,
        }
    })
    updateCookie(cookie, res.headers);

    const html = await res.text();

    let detail;
    try {
        const json = html
            .split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1]
            .split('</script>')[0];

        const data = JSON.parse(json);
        const videoDetail = data["__DEFAULT_SCOPE__"]["webapp.video-detail"];

        if (!videoDetail) throw "no video detail found";

        if (videoDetail.statusMsg) {
            return { error: "content.post.unavailable"};
        }

        detail = videoDetail?.itemInfo?.itemStruct;
    } catch {
        return { error: "fetch.fail" };
    }

    if (detail.isContentClassified) {
        return { error: "content.post.age" };
    }

    if (!detail.author) {
        return { error: "fetch.empty" };
    }

    let video, videoFilename, audioFilename, audio, images,
        filenameBase = `tiktok_${detail.author?.uniqueId}_${postId}`,
        bestAudio;

    const metadata = obj.returnMetadata ? detail : undefined;

    let comments;
    if (obj.loadComments) {
        comments = await fetchComments(postId, cookie, detail.author?.uniqueId, obj.commentsLimit);
        if (!comments) return { error: "fetch.comments" };
    }

    images = detail.imagePost?.images;

    let playAddr = detail.video?.playAddr;

    if (obj.h265) {
        const h265PlayAddr = detail?.video?.bitrateInfo?.find(b => b.CodecType.includes("h265"))?.PlayAddr.UrlList[0]
        playAddr = h265PlayAddr || playAddr
    }

    if (!obj.isAudioOnly && !images) {
        video = playAddr;
        videoFilename = `${filenameBase}.mp4`;
    } else {
        audio = playAddr;
        audioFilename = `${filenameBase}_audio`;

        if (obj.fullAudio || !audio) {
            audio = detail.music.playUrl;
            audioFilename += `_original`
        }
        if (audio.includes("mime_type=audio_mpeg")) bestAudio = 'mp3';
    }

    if (video) {
        let subtitles, fileMetadata;
        if (obj.subtitleLang && detail?.video?.subtitleInfos?.length) {
            const langCode = convertLanguageCode(obj.subtitleLang);
            const subtitle = detail?.video?.subtitleInfos.find(
                s => s.LanguageCodeName.startsWith(langCode) && s.Format === "webvtt"
            )
            if (subtitle) {
                subtitles = subtitle.Url;
                fileMetadata = {
                    sublanguage: langCode,
                }
            }
        }
        return {
            urls: video,
            subtitles,
            fileMetadata,
            metadata,
            comments,
            filename: videoFilename,
            headers: { cookie }
        }
    }

    if (images && obj.isAudioOnly) {
        return {
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            metadata,
            comments,
            headers: { cookie }
        }
    }

    if (images) {
        let imageLinks = images
            .map(i => i.imageURL.urlList.find(p => p.includes(".jpeg?")))
            .map((url, i) => {
                if (obj.alwaysProxy) url = createStream({
                    service: "tiktok",
                    type: "proxy",
                    url,
                    filename: `${filenameBase}_photo_${i + 1}.jpg`
                })

                return {
                    type: "photo",
                    url
                }
            });

        return {
            picker: imageLinks,
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            metadata,
            comments,
            headers: { cookie }
        }
    }

    if (audio) {
        return {
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            metadata,
            comments,
            headers: { cookie }
        }
    }

    return { error: "fetch.empty" };
}
