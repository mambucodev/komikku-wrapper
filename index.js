import { pipeline } from "stream/promises";
import { execSync } from "child_process";
import prompts from "prompts";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { extname, join } from "path";
import * as fs from "fs";

(async () => {
  const onCancel = () => process.exit(0);
  let app_dir;

  const app_dir_options = [
    {
      value: `${process.env.HOME}/.local/share/komikku`,
      title: `Local - ${process.env.HOME}/.local/share/komikku`,
    },
    {
      value: `${process.env.HOME}/.var/app/info.febvre.Komikku/data`,
      title: `Flatpak - ${process.env.HOME}/.var/app/info.febvre.Komikku/data`,
    },
  ].filter((option) => fs.existsSync(option.value));

  switch (app_dir_options.length) {
    case 0:
      throw new Error(
        "Komikku folder not found.\nPlease install either from your distribution's package manager or from Flatpak.",
      );
    case 1:
      app_dir = app_dir_options[0].dir;
      break;
    default:
      const { selected_app } = await prompts(
        {
          type: "select",
          name: "selected_app",
          message: "Select Komikku App:",
          choices: app_dir_options,
        },
        { onCancel },
      );
      app_dir = selected_app;
      break;
  }

  const db = await open({
    filename: `${app_dir}/komikku.db`,
    driver: sqlite3.Database,
  });

  const destination_parent = join(
    process.env.HOME,
    (
      await prompts(
        {
          type: "text",
          name: "folder",
          message: "Destination Folder:",
          initial: "Documents/Manga",
        },
        { onCancel },
      )
    ).folder,
  );

  const mangas = await db.all("SELECT id, server_id, name FROM mangas;");

  const { selected_manga, format, rename, cover } = await prompts(
    [
      {
        type: "select",
        name: "selected_manga",
        message: "Select Manga:",
        choices: mangas.map((manga) => ({
          title: `${manga.name}${mangas.filter((m) => m.name.toLowerCase() == manga.name.toLowerCase()).length > 1 ? ` - ${manga.server_id}` : ""}`,
          value: manga.id,
        })),
      },
      {
        type: "select",
        name: "format",
        message: "Format:",
        choices: [
          { title: "MOBI", value: "MOBI" },
          { title: "EPUB", value: "EPUB" },
          { title: "CBZ", value: "CBZ" },
        ],
        default: "MOBI",
      },
      {
        type: "toggle",
        name: "rename",
        message: "Rename Chapters:",
        description:
          "Rename chapters to their number or leave their original name.",
        initial: false,
        active: "yes",
        inactive: "no",
      },
      {
        type: "toggle",
        name: "cover",
        message: "Download Volume Covers:",
        initial: false,
        active: "yes",
        inactive: "no",
      },
    ],
    { onCancel },
  );

  const manga = mangas.find((manga) => manga.id == selected_manga);

  const custom_covers = new Map();
  if (cover) {
    try {
      const res1 = await (
        await fetch(
          `https://api.mangadex.org/manga?limit=1&title=${encodeURIComponent(manga.name)}`,
        )
      ).json();

      if (res1.data.length === 0) {
        console.log("Volume covers for this manga were not found.");
        return;
      }

      const { id } = res1.data[0];

      try {
        const res2 = await (
          await fetch(
            `https://api.mangadex.org/cover?limit=50&manga%5B%5D=${encodeURIComponent(id)}&locales%5B%5D=ja`,
          )
        ).json();

        if (res2.data.length === 0) {
          console.log("Volume covers for this manga were not found.");
          return;
        }

        for (const cover_data of res2.data) {
          custom_covers.set(
            parseFloat(cover_data.attributes.volume),
            `https://uploads.mangadex.org/covers/${id}/${cover_data.attributes.fileName}`,
          );
        }
      } catch (err) {
        return console.error(err);
      }
    } catch (err) {
      return console.error(err);
    }
  }

  const manga_folder = `${app_dir}/${manga.server_id}/${manga.name}`;
  const destination = `${destination_parent}/${manga.name}`;

  if (fs.existsSync(destination)) {
    const { rmdir } = await prompts(
      [
        {
          type: "confirm",
          name: "rmdir",
          message: `Destination folder already exists. Delete it? (${destination})`,
          initial: false,
        },
      ],
      { onCancel },
    );

    if (!rmdir) return;
  }
  fs.rmSync(destination, { recursive: true });
  fs.mkdirSync(destination);

  const chapters = await db.all(
    "SELECT slug, title, num FROM chapters WHERE manga_id = ? AND downloaded = 1;",
    [manga.id],
  );

  const volume_stops = await (async () => {
    const stops = [];

    async function request_stop() {
      const response = await prompts(
        {
          type: "number",
          float: true,
          name: "stop",
          message: `Volume ${stops.length + 1} stops at:`,
          initial: chapters[chapters.length - 1].num,
        },
        { onCancel },
      );

      stops.push(parseFloat(response.stop));

      if (stops[stops.length - 1] < chapters[chapters.length - 1].num)
        await request_stop();
    }

    await request_stop();

    return stops;
  })();

  const volume_folders = [];

  console.log("Organizing volumes and chapters...");

  for (const volume_index in volume_stops) {
    // console.log(`Processing volume ${parseInt(volume_index) + 1}...`);
    let page_count = 0;

    const volume_start = volume_index == 0 ? 0 : volume_stops[volume_index - 1];

    const volume_dir = `${destination}/Volume ${parseInt(volume_index) + 1}`;
    fs.mkdirSync(volume_dir);

    volume_folders.push(volume_dir);

    const volume_chapters = chapters.filter(
      (chapter) =>
        chapter.num > volume_start && chapter.num <= volume_stops[volume_index],
    );

    for (let i = 0; i < volume_chapters.length; i++) {
      const chapter = volume_chapters[i];
      // console.log(`Processing chapter ${chapter.num}...`);
      const chapter_folder = `${manga_folder}/${chapter.slug}`;

      const pages = fs.readdirSync(chapter_folder);

      const chapter_dir = `${volume_dir}/${rename || !chapter.title ? `Chapter ${chapter.num}` : chapter.title}`;
      fs.mkdirSync(chapter_dir);

      if (cover && custom_covers.has(parseInt(volume_index) + 1) && i === 0) {
        const url = custom_covers.get(parseInt(volume_index) + 1);

        const res = await fetch(url);
        const img_path = `${chapter_dir}/${page_count++}${extname(new URL(url).pathname)}`;
        // return console.log(img_path);
        await pipeline(res.body, fs.createWriteStream(img_path));

        // fs.copyFileSync(`${manga_folder}/cover.jpg`, `${chapter_dir}/${page_count++}.jpg`);
      }

      for (const page of pages) {
        fs.copyFileSync(
          `${chapter_folder}/${page}`,
          `${chapter_dir}/${page_count++}.png`,
        );
      }
    }
  }

  console.log(`Processing comics into ".${format}"...`);

  fs.mkdirSync(`${destination}/Output`);

  for (const volume_index in volume_folders) {
    console.log(`Processing volume ${parseInt(volume_index) + 1}...`);

    const volume = volume_folders[volume_index];
    execSync(
      `kcc-c2e -p K11 -m -f ${format} -b 0 -t "${manga.name} ${parseInt(volume_index) + 1}" -o "${destination}/Output" "${volume}"`,
    );
  }

  console.log(`Done! Processed volumes saved in "${destination}/Output"`);
})();
