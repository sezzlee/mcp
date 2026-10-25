# Faz 3: mevcut Excel dosyasını düzenleme

Durum: kapsam önerisi. Faz 1'in temel yazmasına dayanır; kaynak aktarımı gereken işlerde Faz 2 kullanılır. Açık kararlar [ana yol haritasındadır](../README.md).

## Hedef

Agent, kullanıcının getirdiği mevcut çalışma kitabında hedeflenen değişiklikleri yapabilsin ve korunması gereken içeriği koruyabilsin.

## Kapsam

| Kimlik | İhtiyaç                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3-01  | Düzenlenecek dosyayı ve desteklenen özelliklerini belirlemek.                                                                                                                                       |
| F3-02  | Hücre veya aralık değerlerini, hedef dışındaki içeriği değiştirmeden güncellemek.                                                                                                                   |
| F3-03  | İçerik temizlemeyi, hücre/satır/kolon silme ve kaydırmadan ayırt etmek.                                                                                                                             |
| F3-04  | Satır ve kolon eklemek/silmek; konum ve ilişkili içerik etkisini belirlemek.                                                                                                                        |
| F3-05  | Sayfa eklemek, yeniden adlandırmak, sıralamak, kopyalamak veya silmek.                                                                                                                              |
| F3-06  | Desteklenen kapsamda aralık taşımak ve kopyalamak; içerik ile biçim beklentisini ayırmak.                                                                                                           |
| F3-07  | Kaynak dosyayı koruyarak düzenlenmiş yeni sürüm üretmek; sonraki isteği bu sürümden sürdürebilmek.                                                                                                  |
| F3-08  | İstenen değişikliği incelemek ve geri almak; son işlemi geri alma ile önceki dosya sürümüne dönmeyi ayırt etmek.                                                                                    |
| F3-09  | Copy formulas and cell formatting with ranges and sheets, with explicit values/formulas/formatting/all modes and verified reference behavior. Required by the Phase 2 scope decision of 2026-10-25. |

## Kodlama iş paketleri

1. Düzenlenebilir biçimleri ve korunması gereken özellikleri belirlemek; destek dışı içerik davranışını tanımlamak.
2. Dışarıdan gelen dosyada hedefli hücre ve aralık değişikliğini tamamlamak.
3. Temizleme ve sayfa işlemlerini, ilişkili içerik etkileriyle birlikte eklemek.
4. Satır/kolon ekleme, silme, taşıma ve kopyalama işlemlerini bağımlılık kontrolleriyle tamamlamak.
5. Değişen ve değişmemesi gereken içerikleri ayrı ayrı doğrulamak; çıktı/sürüm ve dış değişiklik davranışını tamamlamak.

## Teslim adımları

- **3A — Hedefli içerik düzenleme:** Önce açıkça hedeflenen değer/aralık değişikliği ve içerik temizleme. Kaynak korunur; başka özelliklere dokunmadan yeni sürüm üretme kanıtlanır.
- **3B — Yapısal düzenleme:** Ardından satır/kolon ekleme-silme, sayfa adı ve sıra değişiklikleri, taşıma/kopyalama. Formül, tablo, isim, kural, grafik ve konum etkileri ilgili işlemle birlikte tamamlanır.

Bu ayrım, yalnızca bir değeri değiştirebilmek için bütün yapısal Excel davranışlarını aynı anda uygulama zorunluluğunu kaldırır. İki adım da kendi koruma kapsamını açıklar; kayıpsız düzenleme iddiası test edilmiş özelliklerle sınırlıdır.

## Bağımlılıklar ve sınırlar

- Faz 0'ın kaynak/çıktı ve işlem sınırı kuralları geçerlidir; asıl dosyanın üzerine yazma bu kapsamda yoktur.
- Mevcut formüller, tablolar, adlandırılmış aralıklar, grafikler, resimler, bağlantılar ve sayfa düzeni koruma kapsamı açısından incelenir.
- Bu özellikleri korumak veya referanslarını güncellemek, onları sıfırdan oluşturmakla aynı yetenek değildir.
- Örneğin sayfa adı değiştirilirken veya satır silinirken ilişkili formüllerin davranışı bu fazda çözülmelidir; Faz 5'e ertelenemez.
- Koruma garantisi verilemeyen bir işlem, uygulanmış ve eksiksiz gibi sunulmamalıdır. Reddetme veya açıkça kabul edilen kayıplı işlem davranışı ayrıca kararlaştırılır.
- Korumalı dosyalar, şifreli dosyalar ve makro içeren biçimler için destek varsayılmaz.
- Koşulla binlerce kaydı seçerek güncelleme ve listeyi tümden yenileme Faz 4'te genişletilir.

## Kabul senaryoları

- F3-09 acceptance: copy a range and a sheet containing formulas, mixed relative/absolute references, cross-sheet references, number formats and cell styles. Independently verify the requested formulas/formatting/all mode, destination references, date meaning, preserved unrelated content and unchanged source bytes. Unsupported references or styles must fail explicitly rather than silently falling back to values. New formula/style authoring remains Phase 5; copying existing formulas and formatting is required in Phase 3.

- Mevcut bir raporda tek tutar değiştirilir; ilgisiz sayfalar ve kabul edilen diğer özellikler korunur.
- İçeriği temizleme ile satırı silme örnekleri farklı beklenen sonuçları verir.
- Bir listeye satır eklenirken alttaki not/toplam ve ilişkili referanslar kabul edilmiş biçimde ele alınır.
- Sayfa yeniden adlandırma ve kopyalama, kapsam içindeki ilişkili içerikle birlikte doğrulanır.
- Desteklenmeyen özellik veya arada değişen dosya, belirlenen davranışla ele alınır.
- Bir düzeltme geri alındığında, üzerinde uzlaşılan işlem sınırına göre beklenen önceki durum elde edilir.
- Aynı dosya tekrar tekrar düzenlendiğinde korunmuş özelliklerin giderek kaybolmadığı kontrol edilir.
- Başarısız yapısal işlem kaynak veya önceki sürümü değiştirmez.
- Çıktı mevcut okuyucuyla ve koruma iddiaları için gerekli bağımsız paket/ilişki kontrolleriyle değerlendirilir.

## Açık kararlar

A-06, A-07 ve A-11: biçimler, koruma kapsamı, referans davranışı ve geri alma sınırı. Kaynak dosyanın korunup yeni sürüm üretilmesi kesin karardır. Aynı adlı sayfa, çakışan taşıma alanı, gizli alanlar, birleştirilmiş hücreler ve son sayfanın silinmesi gibi durumlar ayrıca kararlaştırılır.
